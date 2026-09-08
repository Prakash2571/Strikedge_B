/**
 * SNAPSHOT projections must overwrite in place, end to end.
 *
 * `enqueueOutboxSnapshot` exists for aggregates that are rewritten rather than appended —
 * `box_daily_pnl` is one document per (day, trade_id) whose figures move all day. Unlike an
 * event enqueue it keeps a STABLE `event_id` (so Mongo holds one `_id`) and REVIVES the
 * pending row on conflict: payload replaced, `published_at` cleared, attempts reset.
 *
 * `tests/pg/auditGapFixes.test.mjs` proves the outbox row is revived. It does NOT prove the
 * projector then actually overwrites the Mongo document with the newer value — which is the
 * behaviour that matters, and is the half that would silently fail if the projector treated
 * a re-pending row as already delivered. This closes that gap.
 *
 * Two failure modes are checked explicitly:
 *   * the replica FREEZING at the first value (what a plain `DO NOTHING` enqueue would do);
 *   * the replica ACCUMULATING a document per update (what a time-varying event id would do).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, countDocs, findDoc } from "./helpers.mjs";
import { MongoExportClient } from "../../dist/outbox/mongo.js";
import { Projector } from "../../dist/outbox/projector.js";

const DAY = "2026-09-08";
const TRADE = "aaaaaaaaaaaaaaaaaaaaaaaa";
const EVENT_ID = `box_daily_pnl:${DAY}:${TRADE}`;

/** Enqueue a P&L snapshot the same way the repository does. */
async function enqueueSnapshot(pool, netPnl) {
  const { enqueueOutboxSnapshot } = await import("../../dist/outbox/writer.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await enqueueOutboxSnapshot(client, {
      eventId: EVENT_ID,
      aggregateType: "box_daily_pnl",
      aggregateId: `${DAY}:${TRADE}`,
      eventType: "daily_pnl_snapshot",
      schemaVersion: 3,
      payload: {
        day: DAY,
        trade_id: TRADE,
        net_pnl: netPnl,
        source_id: `${DAY}:${TRADE}`,
        projection_schema_version: 3,
      },
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

test("a revived snapshot OVERWRITES the Mongo document instead of freezing or duplicating", async (t) => {
  const h = await createHarness("snapshot");
  t.after(() => h.cleanup());

  const mongo = new MongoExportClient(h.exportConfig());
  t.after(() => mongo.close());
  const projector = new Projector(h.pool, mongo, {
    batchSize: 50,
    intervalMs: 10,
    maxBackoffMs: 1000,
    maxAttempts: 5,
  });

  // First value, delivered.
  await enqueueSnapshot(h.pool, 100);
  let result = await projector.runOnce();
  assert.equal(result.published, 1, "the first snapshot publishes");

  let doc = await findDoc(h.mongoUri, h.mongoDb, "box_daily_pnl", EVENT_ID);
  assert.ok(doc, "a document exists under the stable event id");
  assert.equal(doc.data.net_pnl, 100, "carrying the first value");
  assert.equal(
    await countDocs(h.mongoUri, h.mongoDb, "box_daily_pnl"),
    1,
    "exactly one document",
  );

  // P&L moves twice more. Both must land, and both must reuse the same _id.
  await enqueueSnapshot(h.pool, 250);
  result = await projector.runOnce();
  assert.equal(
    result.published,
    1,
    "a revived snapshot must be claimed again — if the projector treated the row as already " +
      "delivered, the reporting replica would freeze at the first value",
  );

  await enqueueSnapshot(h.pool, -75);
  await projector.runOnce();

  doc = await findDoc(h.mongoUri, h.mongoDb, "box_daily_pnl", EVENT_ID);
  assert.equal(doc.data.net_pnl, -75, "the replica must hold the LATEST value, including a loss");
  assert.equal(
    await countDocs(h.mongoUri, h.mongoDb, "box_daily_pnl"),
    1,
    "still exactly one document — a per-update document would make the day unreadable",
  );

  // And the outbox row itself is published, not left pending forever.
  const { rows } = await h.pool.query(
    `SELECT published_at, attempts FROM mongo_outbox WHERE event_id = $1`,
    [EVENT_ID],
  );
  assert.equal(rows.length, 1, "one outbox row, reused");
  assert.ok(rows[0].published_at, "and marked published after the final delivery");
});

test("many updates between drains collapse into ONE delivery, bounding the backlog", async (t) => {
  // The useful side effect of snapshot semantics: P&L is recalculated on a timer, so without
  // collapsing, a Mongo outage would grow the backlog without bound purely from recalculation.
  const h = await createHarness("snapcollapse");
  t.after(() => h.cleanup());

  const mongo = new MongoExportClient(h.exportConfig());
  t.after(() => mongo.close());
  const projector = new Projector(h.pool, mongo, {
    batchSize: 50,
    intervalMs: 10,
    maxBackoffMs: 1000,
    maxAttempts: 5,
  });

  for (const net of [1, 2, 3, 4, 5]) await enqueueSnapshot(h.pool, net);

  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM mongo_outbox WHERE published_at IS NULL`,
  );
  assert.equal(rows[0].n, 1, "five updates leave ONE pending row, not five");

  const result = await projector.runOnce();
  assert.equal(result.published, 1, "one delivery");
  const doc = await findDoc(h.mongoUri, h.mongoDb, "box_daily_pnl", EVENT_ID);
  assert.equal(doc.data.net_pnl, 5, "carrying the newest value");
});
