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
 * Runs against REAL PostgreSQL, because for (1) the whole point is that the durable row and
 * its projection row are written in the SAME transaction — a mock of either half would
 * reproduce the bug rather than catch it.
 *
 * USES `tests/pg/helpers.mjs`, NOT the token harness. The first draft of this file combined
 * the token harness with `runMigrations()` and dropped its schema CASCADE on teardown; the
 * pg suite runs files concurrently, so that destroyed relations another file was mid-query
 * on and surfaced in CI as `could not open relation with OID …` in an unrelated test. The
 * shared pg harness gives each file its own schema AND a per-schema connection URL, which
 * is what makes concurrent files safe.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setup, teardown, loadRepository, baseTrade } from "./helpers.mjs";

let ctx;
let repo;
let registryMod;

const DAY = "2026-09-08";

test.before(async () => {
  ctx = await setup("gapfix");
  repo = await loadRepository();
  registryMod = await import("../../dist/brokers/registry.js");
});

test.after(async () => {
  await teardown(ctx);
});

/* ========================================================================== */
/*  1. Daily P&L projection                                                   */
/* ========================================================================== */

async function outboxRow(day, tradeId) {
  const { rows } = await ctx.pool.query(
    `SELECT event_id, aggregate_type, event_type, payload, published_at, attempts
       FROM mongo_outbox WHERE event_id = $1`,
    [`box_daily_pnl:${day}:${tradeId}`],
  );
  return rows[0] ?? null;
}

/**
 * A P&L row needs its SOURCE trade to exist.
 *
 * `upsertBoxDailyPnl` goes through `runSourceSafePnlRowUpsert`, and
 * `isArchivedPnlRowInvalid` treats a P&L row whose trade is absent from `box_trades` as
 * invalid — so it self-cleans instead of writing. That is correct, deliberate behaviour
 * (a P&L row must never outlive its source trade), so the test satisfies it rather than
 * working around it.
 */
async function tradeFor(lower, upper) {
  // `insertBoxTrade` returns the full RECORD, not an id. Getting this wrong made the P&L
  // guard see a non-string trade_id, fail `isValidBoxId`, and self-clean the row — which is
  // the guard behaving correctly on bad input.
  const rec = await repo.insertBoxTrade(baseTrade({ lower_strike: lower, upper_strike: upper }));
  assert.ok(rec, "the source trade must insert");
  const id = String(rec._id);
  assert.ok(repo.isValidBoxId(id), `insertBoxTrade must yield a valid opaque id (got ${id})`);
  return id;
}

test("a daily-P&L write now enqueues a Mongo projection", async () => {
  const tradeId = await tradeFor(21000, 21200);
  await repo.upsertBoxDailyPnl({
    day: DAY,
    trade_id: tradeId,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 21000,
    upper_strike: 21200,
    expiry: "2026-09-24",
    status: "open",
    gross_pnl: 1200,
    net_pnl: 950,
    updated_at: new Date(),
  });

  const row = await outboxRow(DAY, tradeId);
  assert.ok(row, "the P&L write must produce an outbox row — before the fix it produced none");
  assert.equal(row.aggregate_type, "box_daily_pnl");
  assert.equal(row.published_at, null, "it must start unpublished, for the projector to claim");
  assert.equal(Number(row.payload.net_pnl), 950, "the projection must carry the P&L figures");
  assert.equal(
    row.payload.source_id,
    `${DAY}:${tradeId}`,
    "the stable PostgreSQL source id must be present",
  );
  assert.ok(
    Number(row.payload.projection_schema_version) >= 1,
    "the projection schema version must be stamped",
  );
});

test("repeated P&L updates COLLAPSE into one latest-wins row, not a document per update", async () => {
  // A P&L row is a snapshot rewritten as net P&L moves. A plain event enqueue would have
  // frozen the replica at the first value (ON CONFLICT DO NOTHING); a time-varying event id
  // would accumulate a Mongo document per update. Neither is correct.
  const tradeId = await tradeFor(21400, 21600);
  for (const net of [100, 200, 300]) {
    await repo.upsertBoxDailyPnl({
      day: DAY,
      trade_id: tradeId,
      underlying: "NIFTY",
      direction: "LONG_BOX",
      lower_strike: 21400,
      upper_strike: 21600,
      expiry: "2026-09-24",
      status: "open",
      net_pnl: net,
      updated_at: new Date(),
    });
  }

  const { rows } = await ctx.pool.query(
    `SELECT event_id FROM mongo_outbox WHERE aggregate_type = 'box_daily_pnl' AND aggregate_id = $1`,
    [`${DAY}:${tradeId}`],
  );
  assert.equal(rows.length, 1, "three updates must still be ONE outbox row (one Mongo _id)");
  const row = await outboxRow(DAY, tradeId);
  assert.equal(Number(row.payload.net_pnl), 300, "the row must carry the LATEST value");
});

test("a superseded P&L snapshot is revived for delivery rather than left published", async () => {
  // The bug this guards: if the row stayed `published_at`-set after the first delivery,
  // every later P&L movement would never reach the reporting replica.
  const tradeId = await tradeFor(21800, 22000);
  const base = {
    day: DAY,
    trade_id: tradeId,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 21800,
    upper_strike: 22000,
    expiry: "2026-09-24",
    status: "open",
  };
  await repo.upsertBoxDailyPnl({ ...base, net_pnl: 10, updated_at: new Date() });

  // Simulate the projector having delivered it.
  await ctx.pool.query(
    `UPDATE mongo_outbox SET published_at = now(), attempts = 2 WHERE event_id = $1`,
    [`box_daily_pnl:${DAY}:${tradeId}`],
  );

  await repo.upsertBoxDailyPnl({ ...base, net_pnl: 20, updated_at: new Date() });

  const row = await outboxRow(DAY, tradeId);
  assert.equal(row.published_at, null, "a new snapshot must become pending again");
  assert.equal(Number(row.attempts), 0, "the attempt counter must reset for the new value");
  assert.equal(Number(row.payload.net_pnl), 20, "and it must carry the superseding value");
});

test("the P&L projection carries no secret-bearing field", async () => {
  const tradeId = await tradeFor(22200, 22400);
  await repo.upsertBoxDailyPnl({
    day: DAY,
    trade_id: tradeId,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 22200,
    upper_strike: 22400,
    expiry: "2026-09-24",
    status: "open",
    net_pnl: 1,
    updated_at: new Date(),
  });
  const row = await outboxRow(DAY, tradeId);
  const raw = JSON.stringify(row.payload).toLowerCase();
  for (const forbidden of ["access_token", "passcode", "encryption_iv", "api_secret"]) {
    assert.ok(!raw.includes(`"${forbidden}"`), `payload must not contain ${forbidden}`);
  }
});

/* ========================================================================== */
/*  2. DEFAULT_ACTIVE_BROKER / AUTO_FALLBACK_TO_DHAN                          */
/* ========================================================================== */

/** Construct a manager under a temporary environment, restoring it afterwards. */
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
    "an explicit dhan default must actually take effect — before the fix it did not",
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
