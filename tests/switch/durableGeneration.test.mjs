/**
 * Durable active_broker generation semantics (migration 006 + brokerSessions).
 *
 * Proves the generation is monotonic, never repeats, comes from PostgreSQL, and
 * survives a restart — the property durable instrument reservations rely on.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — createPgHarness throws at setup.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPgHarness, TEST_KEY_HEX } from "../tokens/helpers.mjs";

let h;
let store;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  h = await createPgHarness("gen");
  store = await import("../../dist/brokerState/brokerSessions.js");
});
after(async () => {
  if (h) await h.cleanup();
});
beforeEach(async () => {
  const c = await h.raw();
  await c.query(`TRUNCATE active_broker`);
  // Reset the sequence so each test starts predictably.
  await c.query(`ALTER SEQUENCE active_broker_generation_seq RESTART WITH 1`);
  c.release();
});

test("a fresh flat deployment records the default active broker and generation 1", async () => {
  const saved = await store.saveActiveBroker("zerodha", "boot_default", { reason: "fresh deployment default", tradingDay: "2026-09-08" });
  assert.equal(saved.generation, 1);
  const loaded = await store.loadActiveBroker();
  assert.equal(loaded.broker, "zerodha");
  assert.equal(loaded.generation, 1);
});

test("each switch advances the generation and returns the NEW value", async () => {
  const g1 = await store.saveActiveBroker("zerodha", "boot");
  const g2 = await store.saveActiveBroker("dhan", "operator");
  const g3 = await store.saveActiveBroker("zerodha", "operator");
  assert.equal(g1.generation, 1);
  assert.equal(g2.generation, 2);
  assert.equal(g3.generation, 3);
  const loaded = await store.loadActiveBroker();
  assert.equal(loaded.broker, "zerodha");
  assert.equal(loaded.generation, 3);
});

test("the generation is strictly monotonic and never repeats, even for the same broker", async () => {
  const seen = new Set();
  let last = 0;
  for (let i = 0; i < 8; i++) {
    const broker = i % 2 === 0 ? "zerodha" : "dhan";
    const { generation } = await store.saveActiveBroker(broker, "op");
    assert.ok(generation > last, `generation must increase: ${generation} > ${last}`);
    assert.equal(seen.has(generation), false, "generation must never repeat");
    seen.add(generation);
    last = generation;
  }
});

test("generation is monotonic across a simulated restart (a fresh module instance)", async () => {
  await store.saveActiveBroker("zerodha", "boot");
  await store.saveActiveBroker("dhan", "op"); // generation 2
  const before = await store.loadActiveBroker();
  assert.equal(before.generation, 2);

  // Restart: fresh module instance reads the SAME durable row, then switches again.
  const fresh = await import(`../../dist/brokerState/brokerSessions.js?gen=${Date.now()}`);
  const restored = await fresh.loadActiveBroker();
  assert.equal(restored.generation, 2, "the restart adopts the persisted generation, not 1");
  const next = await fresh.saveActiveBroker("zerodha", "op");
  assert.ok(next.generation > 2, "the next generation after restart continues upward, never resets");
});

test("concurrent switches cannot land on the same generation", async () => {
  await store.saveActiveBroker("zerodha", "boot"); // seed
  const results = await Promise.all([
    store.saveActiveBroker("dhan", "a"),
    store.saveActiveBroker("zerodha", "b"),
    store.saveActiveBroker("dhan", "c"),
    store.saveActiveBroker("zerodha", "d"),
  ]);
  const gens = results.map((r) => r.generation);
  assert.equal(new Set(gens).size, gens.length, "no two concurrent switches share a generation");
});

test("saveActiveBroker rejects an invalid broker name", async () => {
  await assert.rejects(() => store.saveActiveBroker("etrade", "op"), /invalid broker/i);
});

/**
 * The durable `active_broker` record OUTRANKS `DEFAULT_ACTIVE_BROKER`.
 *
 * `DEFAULT_ACTIVE_BROKER` was specified and documented with ZERO references in `src` — the
 * initial broker was hardcoded, so setting it did nothing. It is now honoured, and this is
 * the load-bearing half of that change: it decides the FIRST boot of a fresh deployment and
 * nothing else. A restart must never silently revert an operator's broker switch because a
 * config default disagrees with it, since new trades would then be stamped with a broker the
 * operator did not choose — a mistake that becomes invisible once written.
 *
 * Lives in the switch suite rather than tests/pg because it needs migrations 005/006
 * (broker_sessions, active_broker), which the pg harness deliberately does not apply.
 */
test("the durable active_broker record outranks DEFAULT_ACTIVE_BROKER", async () => {
  const sessions = await import("../../dist/brokerState/brokerSessions.js");
  const registryMod = await import("../../dist/brokers/registry.js");

  await sessions.saveActiveBroker("dhan", "test-operator");

  const saved = process.env.DEFAULT_ACTIVE_BROKER;
  process.env.DEFAULT_ACTIVE_BROKER = "zerodha";
  let mgr;
  try {
    mgr = new registryMod.ActiveBrokerManager({
      kite: {
        getApiKey: () => "",
        getAccessToken: () => null,
        clearSession: () => {},
        getInstruments: async () => [],
        getQuoteFull: async () => ({}),
      },
      tickerHub: {
        addTickListener: () => () => {},
        addConnectionListener: () => () => {},
        retain: () => () => {},
        seed: () => {},
        ingestExternalTicks: () => {},
        setExternalConnected: () => {},
        getLatestTick: () => null,
        subscribeTokens: () => {},
        unsubscribeTokens: () => {},
        subscribedCount: () => 0,
        isConnected: () => false,
      },
      boxConfig: () => ({}),
      istDayKey: () => "2026-09-08",
      zerodhaCredentials: () => ({ apiKey: "", accessToken: null }),
      onDhanTicks: () => {},
    });
  } finally {
    if (saved === undefined) delete process.env.DEFAULT_ACTIVE_BROKER;
    else process.env.DEFAULT_ACTIVE_BROKER = saved;
  }

  assert.equal(mgr.activeBroker, "zerodha", "starts on the configured default");
  await mgr.restore();
  assert.equal(
    mgr.activeBroker,
    "dhan",
    "restore() must adopt the durable selection over the config default",
  );
});
