/**
 * OUTBOX PAYLOAD CONTRACT — per-aggregate provenance, against a real PostgreSQL.
 *
 * WHY THIS EXISTS
 * `docs/MONGO_PROJECTION.md`, `docs/PG_PERSISTENCE.md` and the outbox writer's
 * `OUTBOX_AGGREGATES` allow-list all CLAIM that every projected Mongo document carries
 * provenance — broker, charge origin/rate version, margin source, execution mode, the
 * stable PostgreSQL `source_id`, and a `projection_schema_version`. Nothing verified
 * that claim: the 1,613-test baseline never read a `mongo_outbox` payload and asserted
 * its shape per aggregate. A field silently dropped from a projection is invisible —
 * it only shows up much later as unanalysable Mongo history.
 *
 * WHAT IT PINS
 * It drives each repository write that enqueues a projection through the REAL
 * `enqueueOutbox` path, reads the resulting `mongo_outbox` rows, and asserts the
 * provenance each aggregate must carry. It also documents the audit finding that the
 * declared/allow-listed/documented `box_daily_pnl` aggregate is NEVER enqueued by any
 * live write path (only the one-off legacy import writes that collection), by proving a
 * daily-P&L archive write produces no outbox row.
 *
 * It runs against the local PostgreSQL at DATABASE_URL and FAILS LOUDLY if it is
 * missing — it never skips silently.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseTrade, baseIntent, audit } from "./helpers.mjs";

let ctx;
let repo;
let query;

test.before(async () => {
  ctx = await setup("outbox_contract");
  repo = await loadRepository();
  ({ query } = ctx.pool);
});
test.after(async () => { await teardown(ctx); });

/** Read outbox rows for one aggregate id, oldest first. */
async function outboxFor(aggregateType, aggregateId) {
  const { rows } = await query(
    `SELECT aggregate_type, aggregate_id, event_type, schema_version, payload
       FROM mongo_outbox
      WHERE aggregate_type = $1 AND aggregate_id = $2
      ORDER BY sequence ASC`,
    [aggregateType, aggregateId],
  );
  return rows;
}

/** The invariants EVERY projected payload must satisfy, whatever the aggregate. */
function assertUniversalProvenance(row, expectedSourcePresent = true) {
  const p = row.payload;
  assert.ok(p && typeof p === "object", `${row.aggregate_type} payload must be an object`);
  if (expectedSourcePresent) {
    assert.ok(
      typeof p.source_id === "string" && p.source_id.length > 0,
      `${row.aggregate_type} payload must carry a non-empty stable PostgreSQL source_id`,
    );
  }
  assert.ok(
    Object.prototype.hasOwnProperty.call(p, "broker"),
    `${row.aggregate_type} payload must carry broker`,
  );
  assert.equal(
    p.projection_schema_version,
    row.schema_version,
    `${row.aggregate_type} payload projection_schema_version must match the outbox row schema_version`,
  );
  assert.ok(
    Number.isInteger(p.projection_schema_version) && p.projection_schema_version >= 1,
    `${row.aggregate_type} projection_schema_version must be a positive integer`,
  );
}

test("box_trade projection carries the full provenance set", async () => {
  const trade = await repo.insertBoxTrade(
    baseTrade({ broker: "dhan", execution_mode: "live", charge_origin: "broker", charge_rate_version: "v3" }),
  );
  assert.ok(trade, "insertBoxTrade must return a record when PostgreSQL is ready");

  const rows = await outboxFor("box_trade", trade._id);
  assert.equal(rows.length, 1, "one trade_opened projection is enqueued");
  const [row] = rows;
  assert.equal(row.event_type, "trade_opened");
  assertUniversalProvenance(row);

  const p = row.payload;
  assert.equal(p.source_id, trade._id, "source_id is the durable PostgreSQL trade id");
  assert.equal(p.broker, "dhan", "broker reflects the trade's broker");
  assert.equal(p.execution_mode, "live", "execution_mode is projected");
  assert.equal(p.charge_origin, "broker", "charge_origin is projected");
  assert.equal(p.charge_rate_version, "v3", "charge_rate_version is projected");
  assert.ok(
    Object.prototype.hasOwnProperty.call(p, "margin_source"),
    "margin_source provenance is projected (unknown|broker)",
  );
  assert.ok(["unknown", "broker"].includes(p.margin_source), `margin_source must be unknown|broker, got ${p.margin_source}`);
});

test("box_trade margin update enqueues a second provenance-bearing projection", async () => {
  const trade = await repo.insertBoxTrade(baseTrade({ broker: "zerodha" }));
  await repo.setBoxTradeMargin(trade._id, 12345);
  const rows = await outboxFor("box_trade", trade._id);
  assert.equal(rows.length, 2, "trade_opened + trade_margin");
  const margin = rows.find((r) => r.event_type === "trade_margin");
  assert.ok(margin, "a trade_margin projection exists");
  assertUniversalProvenance(margin);
  assert.equal(margin.payload.margin_source, "broker", "a fetched margin marks margin_source=broker");
});

test("box_order_intent projection carries broker, broker_mode, execution_mode and source_id", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k1_ce:a1`;
  const intent = baseIntent({ client_order_id: coid, broker: "dhan", broker_mode: "live" });
  const created = await repo.createBoxOrderIntent(intent);

  const rows = await outboxFor("box_order_intent", created._id);
  assert.ok(rows.length >= 1, "at least the intent_created projection is enqueued");
  const first = rows[0];
  assert.equal(first.event_type, "intent_created");
  assertUniversalProvenance(first);

  const p = first.payload;
  assert.equal(p.source_id, created._id);
  assert.equal(p.broker, "dhan");
  assert.equal(p.broker_mode, "live", "broker_mode is projected");
  assert.equal(p.execution_mode, "live", "live broker_mode maps to execution_mode=live");
});

test("box_execution_attempt projection carries broker, charge_rate_version, execution_mode and source_id", async () => {
  const attemptId = await repo.insertBoxExecutionAttempt({
    candidate_key: `cand-${Math.random().toString(36).slice(2)}`,
    direction: "LONG_BOX",
    underlying: "NIFTY",
    name: "NIFTY",
    is_index: true,
    expiry: "2026-09-24",
    lower_strike: 25000,
    upper_strike: 25200,
    lot_size: 75,
    quantity: 75,
    execution_mode: "paper_legging",
    broker: "zerodha",
    detected_at: new Date(),
    resolved_at: new Date(),
    charge_rate_version: "v7",
    filled_leg_count: 0,
    failed_legs: [],
    resolved: true,
  });
  assert.ok(attemptId, "insertBoxExecutionAttempt returns an id when PostgreSQL is ready");

  const rows = await outboxFor("box_execution_attempt", attemptId);
  assert.equal(rows.length, 1, "one attempt_recorded projection is enqueued");
  const [row] = rows;
  assert.equal(row.event_type, "attempt_recorded");
  assertUniversalProvenance(row);

  const p = row.payload;
  assert.equal(p.source_id, attemptId);
  assert.equal(p.broker, "zerodha");
  assert.equal(p.execution_mode, "paper_legging");
  assert.equal(p.charge_rate_version, "v7", "charge_rate_version is projected");
  assert.ok(
    Object.prototype.hasOwnProperty.call(p, "charge_origin"),
    "charge_origin key is present on the attempt payload (null by design — an attempt has no charge origin)",
  );
});

test("box_trade_event projection carries broker, execution_mode and source_id", async () => {
  const candidateKey = `evt-${Math.random().toString(36).slice(2)}`;
  await repo.appendBoxEvent({
    event: "DETECTED",
    candidate_key: candidateKey,
    underlying: "NIFTY",
    expiry: "2026-09-24",
    lower_strike: 25000,
    upper_strike: 25200,
    lot_size: 75,
    quantity: 75,
    execution_mode: "paper_touch",
    broker: "dhan",
  });

  // aggregateId falls back to the candidate_key when there is no trade id yet.
  const rows = await outboxFor("box_trade_event", candidateKey);
  assert.equal(rows.length, 1, "one box_trade_event projection is enqueued");
  const [row] = rows;
  assertUniversalProvenance(row);
  const p = row.payload;
  assert.equal(p.broker, "dhan");
  assert.equal(p.execution_mode, "paper_touch");
  assert.equal(p.event, "DETECTED");
});

test("box_calibration_sample projection carries broker and source_id", async () => {
  await repo.persistBoxCalibrationSamples(
    [{ broker: "zerodha", kind: "latency", profile: "entry", bucket: "b1", stage: "submit", valueMs: 12.5, session: "s1", atWall: Date.now() }],
    "IN",
  );

  const { rows } = await query(
    `SELECT aggregate_type, aggregate_id, event_type, schema_version, payload
       FROM mongo_outbox WHERE aggregate_type = 'box_calibration_sample' ORDER BY sequence ASC`,
  );
  assert.ok(rows.length >= 1, "a calibration sample projection is enqueued");
  const row = rows[rows.length - 1];
  assert.equal(row.event_type, "calibration_sample");
  assertUniversalProvenance(row);
  assert.equal(row.payload.broker, "zerodha");
});

test("AUDIT FINDING: box_daily_pnl is allow-listed and documented but NEVER enqueued by a live write path", async () => {
  // Writing a daily-P&L archive row goes through plain PostgreSQL queries
  // (upsertDailyPnlRow / rewriteBoxDailyPnlSummary), NOT enqueueOutbox. So the
  // reporting replica's `box_daily_pnl` collection is only ever populated by the
  // one-off legacy import (src/scripts/migrateBoxFromMongo.ts), never by ongoing
  // operation — despite MONGO_PROJECTION.md listing it as a projected collection,
  // OUTBOX_AGGREGATES allow-listing it, and src/box/config.ts claiming daily P&L is
  // "drained into the box_daily_pnl Mongo collection".
  await repo.upsertBoxDailyPnl({
    day: "2026-09-08",
    trade_id: `dp-${Math.random().toString(36).slice(2)}`,
    underlying: "NIFTY",
    direction: "LONG_BOX",
    lower_strike: 25000,
    upper_strike: 25200,
    expiry: "2026-09-24",
    status: "closed",
    gross_pnl: 100,
    net_pnl: 90,
    realisable_net_pnl: 90,
    realised_net_pnl: 90,
    opened_at: new Date(),
    closed_at: new Date(),
    updated_at: new Date().toISOString(),
  });

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM mongo_outbox WHERE aggregate_type = 'box_daily_pnl'`,
  );
  assert.equal(
    rows[0].n,
    0,
    "box_daily_pnl is never enqueued to the outbox by a live write path (finding pinned; " +
      "change this assertion if a live projection is ever added).",
  );
});
