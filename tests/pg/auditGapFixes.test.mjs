/**
 * Two gaps found by audit, both of the "a claim that nothing verifies" class.
 *
 * 1. DAILY P&L WAS NEVER PROJECTED TO MONGODB.
 *    `box_daily_pnl` is an allow-listed outbox aggregate, is collection-mapped in
 *    `src/outbox/mongo.ts`, and `docs/MONGO_PROJECTION.md` says it is projected — but no
 *    code path ever enqueued it. The only writer of that Mongo collection was the legacy
 *    import. Nothing failed and no test noticed, because PostgreSQL (the authority) was
 *    always correct; the loss was silent and would have surfaced much later as
 *    unanalysable history.
 *
 * 2. `DEFAULT_ACTIVE_BROKER` AND `AUTO_FALLBACK_TO_DHAN` WERE NEVER READ.
 *    Both are in the specification and were documented, and `grep` found zero references
 *    in `src/`. The initial broker was hardcoded, so setting `DEFAULT_ACTIVE_BROKER=dhan`
 *    silently did nothing.
 *
 * These tests run against REAL PostgreSQL, because for (1) the whole point is that a
 * durable row and its projection row are written in the SAME transaction — a mock of
 * either half would reproduce the bug rather than catch it.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { createPgHarness } from "../tokens/helpers.mjs";

let harness;
let repo;
let registryMod;

before(async () => {
  harness = await createPgHarness("gapfix");
  // The full Box schema, not just the broker tables the token harness creates.
  const { runMigrations } = await import("../../dist/pg/migrate.js");
  await runMigrations();
  repo = await import("../../dist/box/repository.js");
  registryMod = await import("../../dist/brokers/registry.js");
});

after(async () => {
  await harness.cleanup();
});

/* ========================================================================== */
/*  1. Daily P&L projection                                                   */
/* ========================================================================== */

async function outboxRowsFor(day, tradeId) {
  const c = await harness.raw();
  try {
    const { rows } = await c.query(
      `SELECT event_id, aggregate_type, event_type, payload, published_at, attempts
         FROM mongo_outbox WHERE event_id = $1`,
      [`box_daily_pnl:${day}:${tradeId}`],
    );
    return rows;
  } finally {
    c.release();
  }
}

const DAY = "2026-09-08";

/**
 * Create the SOURCE trade a P&L row belongs to.
 *
 * Required, and the reason the first draft of this suite failed: `upsertBoxDailyPnl` runs
 * through `runSourceSafePnlRowUpsert`, and `isArchivedPnlRowInvalid` treats a P&L row whose
 * trade is absent from `box_trades` as invalid — so it takes the `remove` path and
 * self-cleans instead of writing. That is correct, deliberate behaviour (a P&L row must
 * never outlive its source trade), so the test has to satisfy it rather than work around it.
 */
async function createSourceTrade(tradeId, underlying) {
  const c = await harness.raw();
  try {
    await c.query(
      `INSERT INTO box_trades
         (id, underlying, expiry, lower_strike, upper_strike, lot_size, quantity,
          box_width, entry_box_cost, entry_gross_edge, entry_net_edge)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [tradeId, underlying, "2026-09-24", 2500, 2600, 250, 250, 100, 98.5, 375, 225],
    );
  } finally {
    c.release();
  }
}

test("a daily-P&L write now enqueues a Mongo projection", async () => {
  const tradeId = "aaaaaaaaaaaaaaaaaaaaaaa1";
  await createSourceTrade(tradeId, "RELIANCE");
  await repo.upsertBoxDailyPnl({
    day: DAY,
    trade_id: tradeId,
    underlying: "RELIANCE",
    direction: "LONG_BOX",
    lower_strike: 2500,
    upper_strike: 2600,
    expiry: "2026-09-24",
    status: "open",
    gross_pnl: 1200,
    net_pnl: 950,
    updated_at: new Date(),
  });

  const rows = await outboxRowsFor(DAY, tradeId);
  assert.equal(rows.length, 1, "the P&L write must produce exactly one outbox row");
  assert.equal(rows[0].aggregate_type, "box_daily_pnl");
  assert.equal(rows[0].published_at, null, "it must start unpublished, for the projector");
  assert.equal(rows[0].payload.net_pnl, 950, "the projection must carry the P&L figures");
  assert.equal(
    rows[0].payload.source_id,
    `${DAY}:${tradeId}`,
    "the stable PostgreSQL source id must be present",
  );
  assert.ok(
    rows[0].payload.projection_schema_version >= 1,
    "the projection schema version must be stamped",
  );
});

test("repeated P&L updates COLLAPSE into one latest-wins row, not a document per update", async () => {
  // A P&L row is a snapshot rewritten as net P&L moves. A plain event enqueue would have
  // frozen the replica at the first value (ON CONFLICT DO NOTHING); a time-varying event id
  // would accumulate a Mongo document per update. Neither is right.
  const tradeId = "aaaaaaaaaaaaaaaaaaaaaaa2";
  await createSourceTrade(tradeId, "TCS");
  for (const net of [100, 200, 300]) {
    await repo.upsertBoxDailyPnl({
      day: DAY,
      trade_id: tradeId,
      underlying: "TCS",
      direction: "LONG_BOX",
      lower_strike: 3000,
      upper_strike: 3100,
      expiry: "2026-09-24",
      status: "open",
      net_pnl: net,
      updated_at: new Date(),
    });
  }

  const rows = await outboxRowsFor(DAY, tradeId);
  assert.equal(rows.length, 1, "three updates must still be ONE outbox row (one Mongo _id)");
  assert.equal(rows[0].payload.net_pnl, 300, "the row must carry the LATEST value");
});

test("a superseded P&L snapshot is revived for delivery rather than left published", async () => {
  // The bug this guards: if the row were left `published_at`-set after the first delivery,
  // every later P&L movement would never reach the replica.
  const tradeId = "aaaaaaaaaaaaaaaaaaaaaaa3";
  await createSourceTrade(tradeId, "INFY");
  const base = {
    day: DAY,
    trade_id: tradeId,
    underlying: "INFY",
    direction: "SHORT_BOX",
    lower_strike: 1500,
    upper_strike: 1600,
    expiry: "2026-09-24",
    status: "open",
  };
  await repo.upsertBoxDailyPnl({ ...base, net_pnl: 10, updated_at: new Date() });

  // Simulate the projector having delivered it.
  const c = await harness.raw();
  try {
    await c.query(
      `UPDATE mongo_outbox SET published_at = now(), attempts = 2 WHERE event_id = $1`,
      [`box_daily_pnl:${DAY}:${tradeId}`],
    );
  } finally {
    c.release();
  }

  await repo.upsertBoxDailyPnl({ ...base, net_pnl: 20, updated_at: new Date() });

  const rows = await outboxRowsFor(DAY, tradeId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].published_at, null, "a new snapshot must become pending again");
  assert.equal(rows[0].attempts, 0, "the attempt counter must reset for the new value");
  assert.equal(rows[0].payload.net_pnl, 20, "and carry the superseding value");
});

test("the P&L projection carries no secret-bearing field", async () => {
  const rows = await outboxRowsFor(DAY, "aaaaaaaaaaaaaaaaaaaaaaa1");
  const raw = JSON.stringify(rows[0].payload).toLowerCase();
  for (const forbidden of ["access_token", "passcode", "encryption_iv", "api_secret"]) {
    assert.ok(!raw.includes(`"${forbidden}"`), `payload must not contain ${forbidden}`);
  }
});

/* ========================================================================== */
/*  2. DEFAULT_ACTIVE_BROKER / AUTO_FALLBACK_TO_DHAN                          */
/* ========================================================================== */

function managerWithEnv(env) {
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return new registryMod.ActiveBrokerManager({
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
      istDayKey: () => DAY,
      zerodhaCredentials: () => ({ apiKey: "", accessToken: null }),
      onDhanTicks: () => {},
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("DEFAULT_ACTIVE_BROKER is honoured on a fresh deployment", () => {
  assert.equal(
    managerWithEnv({ DEFAULT_ACTIVE_BROKER: undefined }).activeBroker,
    "zerodha",
    "unset must mean Zerodha — the specified morning default",
  );
  assert.equal(
    managerWithEnv({ DEFAULT_ACTIVE_BROKER: "dhan" }).activeBroker,
    "dhan",
    "an explicit dhan default must actually take effect",
  );
  assert.equal(
    managerWithEnv({ DEFAULT_ACTIVE_BROKER: "ZERODHA" }).activeBroker,
    "zerodha",
    "the value must be case-insensitive",
  );
});

test("an unknown DEFAULT_ACTIVE_BROKER falls back to Zerodha rather than failing startup", () => {
  // A typo must not take down a process whose durable record is about to override it.
  assert.equal(managerWithEnv({ DEFAULT_ACTIVE_BROKER: "kite" }).activeBroker, "zerodha");
});

test("AUTO_FALLBACK_TO_DHAN defaults to false and is strict about truthiness", () => {
  assert.equal(managerWithEnv({ AUTO_FALLBACK_TO_DHAN: undefined }).mayAutoFallbackToDhan(), false);
  assert.equal(managerWithEnv({ AUTO_FALLBACK_TO_DHAN: "false" }).mayAutoFallbackToDhan(), false);
  assert.equal(
    managerWithEnv({ AUTO_FALLBACK_TO_DHAN: "ture" }).mayAutoFallbackToDhan(),
    false,
    "a typo must never enable an automatic venue change",
  );
  assert.equal(managerWithEnv({ AUTO_FALLBACK_TO_DHAN: "true" }).mayAutoFallbackToDhan(), true);
});

test("the durable active_broker record OUTRANKS DEFAULT_ACTIVE_BROKER", async () => {
  // The load-bearing half: a restart must never silently revert an operator's broker
  // switch just because a config default says otherwise.
  const sessions = await import("../../dist/brokerState/brokerSessions.js");
  await sessions.saveActiveBroker("dhan", "test-operator");

  const m = managerWithEnv({ DEFAULT_ACTIVE_BROKER: "zerodha" });
  assert.equal(m.activeBroker, "zerodha", "starts on the configured default");
  await m.restore();
  assert.equal(
    m.activeBroker,
    "dhan",
    "restore() must adopt the durable selection over the config default",
  );
});
