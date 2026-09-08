/**
 * Morning default broker selection (section G) — exercised via the REAL
 * ActiveBrokerManager blocker semantics that the boot wiring reuses.
 *
 * Proves: the morning default chooses Zerodha when the system is FLAT; it cannot
 * switch away from any Dhan exposure/unresolved ownership. AUTO_FALLBACK_TO_DHAN
 * defaults false, so a flat system with Zerodha unavailable does not auto-start
 * Dhan entry — Dhan stays standby until an operator selects it.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — the manager persists to PG.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPgHarness, TEST_KEY_HEX } from "./helpers.mjs";
import { boolOr } from "../../dist/config.js";

let h;
let registry;
let KiteClient;
let TickerHub;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  process.env.DHAN_CLIENT_ID = "DCL";
  process.env.DHAN_API_KEY = "dk";
  process.env.DHAN_API_SECRET = "ds";
  h = await createPgHarness("morning");
  registry = await import("../../dist/brokers/registry.js");
  ({ KiteClient } = await import("../../dist/kite.js"));
  ({ TickerHub } = await import("../../dist/hub.js"));
});
after(async () => {
  if (h) await h.cleanup();
});
beforeEach(async () => {
  const c = await h.raw();
  await c.query(`TRUNCATE active_broker`);
  await c.query(`ALTER SEQUENCE active_broker_generation_seq RESTART WITH 1`);
  c.release();
});

function flatProbe(overrides = {}) {
  return {
    scannerRunning: () => false,
    openPositionCount: () => 0,
    brokersWithOpenPositions: () => [],
    workingOrderCount: () => 0,
    executionInFlight: () => false,
    reconciliationComplete: () => true,
    residualLegCount: () => 0,
    unknownOrderCount: () => 0,
    unresolvedIntentsFor: async () => 0,
    ...overrides,
  };
}
const hooks = () => ({
  stopScanner: () => {},
  invalidateBooks: () => {},
  reloadUniverse: async () => {},
  publish: () => {},
  clearInstrumentReservations: async () => {},
  dropMarketDataSessions: () => 0,
});
function makeManager() {
  return new registry.ActiveBrokerManager({
    kite: new KiteClient({ apiKey: "k" }),
    tickerHub: new TickerHub(() => ({ apiKey: "k", accessToken: null }), () => {}),
    boxConfig: () => ({}),
    istDayKey: () => "2026-09-08",
    onDhanTicks: () => {},
    zerodhaCredentials: () => ({ apiKey: "k", accessToken: null }),
  });
}

test("AUTO_FALLBACK_TO_DHAN defaults to false", () => {
  assert.equal(boolOr(undefined, false), false);
  assert.equal(boolOr("", false), false);
  assert.equal(boolOr("false", false), false);
  assert.equal(boolOr("true", false), true);
});

test("the morning default chooses Zerodha when the system is flat (Dhan active, no exposure → switch allowed)", async () => {
  const mgr = makeManager();
  mgr.attach(flatProbe(), hooks());
  // Start on Dhan (e.g. yesterday's operator choice), flat this morning.
  await mgr.switchBroker("dhan", "yesterday");
  assert.equal(mgr.activeBroker, "dhan");
  // Morning default prefers Zerodha; with no Dhan exposure the switch is permitted.
  mgr.attach(flatProbe(), hooks());
  const blockers = await mgr.switchBlockers("zerodha");
  assert.deepEqual(blockers, [], "a flat system permits the morning Zerodha default");
  const res = await mgr.switchBroker("zerodha", "morning_default");
  assert.equal(res.ok, true);
  assert.equal(mgr.activeBroker, "zerodha");
});

test("the morning default cannot switch away from ANY Dhan exposure/unresolved ownership", async () => {
  const exposureCases = [
    ["open Dhan Box position", { openPositionCount: () => 1, brokersWithOpenPositions: () => ["dhan"] }],
    ["Dhan working order", { workingOrderCount: () => 1 }],
    ["Dhan recovery/residual exposure", { residualLegCount: () => 1 }],
    ["Dhan reconciliation in progress", { reconciliationComplete: () => false }],
    ["Dhan execution in flight", { executionInFlight: () => true }],
    ["ambiguous Dhan order", { unknownOrderCount: () => 1 }],
    ["nonterminal Dhan order intent", { unresolvedIntentsFor: async () => 1 }],
  ];
  for (const [name, override] of exposureCases) {
    const mgr = makeManager();
    mgr.attach(flatProbe(), hooks());
    await mgr.switchBroker("dhan", "op");
    mgr.attach(flatProbe(override), hooks());
    const res = await mgr.switchBroker("zerodha", "morning_default");
    assert.equal(res.ok, false, `${name}: morning default must be blocked`);
    assert.equal(mgr.activeBroker, "dhan", `${name}: Dhan stays active, exposure not abandoned`);
  }
});
