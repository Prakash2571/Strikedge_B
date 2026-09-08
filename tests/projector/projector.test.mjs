/**
 * Core projector behaviour: happy-path publish, idempotent redelivery, restart
 * recovery, partial-batch failure isolation, and per-aggregate ordering.
 *
 * Integration test against real PostgreSQL and MongoDB. Fails loudly if either is
 * missing (see helpers.createHarness).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, enqueueRow, countDocs, findDoc } from "./helpers.mjs";
import { MongoExportClient } from "../../dist/outbox/mongo.js";
import { Projector } from "../../dist/outbox/projector.js";

test("projector: publishes pending rows exactly once and marks them published", async (t) => {
  const h = await createHarness("core_publish");
  t.after(() => h.cleanup());

  await enqueueRow(h.pool, {
    eventId: "trade-1-opened",
    aggregateType: "box_trade",
    aggregateId: "trade-1",
    eventType: "trade_opened",
    payload: { net_pnl: 1425, underlying: "NIFTY" },
  });

  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, {
    batchSize: 100,
    intervalMs: 50,
    maxBackoffMs: 60_000,
    maxAttempts: 5,
  });
  t.after(() => mongo.close());

  const res = await projector.runOnce();
  assert.equal(res.claimed, 1);
  assert.equal(res.published, 1);

  const doc = await findDoc(h.mongoUri, h.mongoDb, "box_trades", "trade-1-opened");
  assert.ok(doc, "document should exist in box_trades");
  assert.equal(doc._id, "trade-1-opened");
  assert.equal(doc.data.net_pnl, 1425);
  assert.equal(doc.aggregate_id, "trade-1");

  const { rows } = await h.pool.query(`SELECT published_at FROM mongo_outbox WHERE event_id = $1`, ["trade-1-opened"]);
  assert.ok(rows[0].published_at, "row should be marked published");
});

test("projector: restart with pending rows publishes them (recovery by re-read)", async (t) => {
  const h = await createHarness("restart");
  t.after(() => h.cleanup());

  // Simulate a process that committed outbox rows but crashed before draining.
  for (let i = 0; i < 3; i++) {
    await enqueueRow(h.pool, {
      eventId: `evt-${i}`,
      aggregateType: "box_daily_pnl",
      aggregateId: `2026-09-08:trade-${i}`,
      eventType: "daily_pnl",
      payload: { net_pnl: 100 * i },
    });
  }

  // "Restart": a fresh client + projector reads the unpublished rows.
  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());

  const res = await projector.runOnce();
  assert.equal(res.published, 3);
  assert.equal(await countDocs(h.mongoUri, h.mongoDb, "box_daily_pnl"), 3);

  // A second pass has nothing left to do.
  const res2 = await projector.runOnce();
  assert.equal(res2.claimed, 0);
  assert.equal(await countDocs(h.mongoUri, h.mongoDb, "box_daily_pnl"), 3);
});

test("projector: duplicate delivery upserts the same _id (no second doc, no doubled P&L)", async (t) => {
  const h = await createHarness("dupe");
  t.after(() => h.cleanup());

  await enqueueRow(h.pool, {
    eventId: "pnl-day-1-trade-1",
    aggregateType: "box_daily_pnl",
    aggregateId: "trade-1",
    eventType: "daily_pnl",
    payload: { net_pnl: 500 },
  });

  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());

  await projector.runOnce();

  // Simulate a redelivery: reset the row to pending (crash between Mongo write and
  // PostgreSQL mark-published) and drain again.
  await h.pool.query(`UPDATE mongo_outbox SET published_at = NULL WHERE event_id = $1`, ["pnl-day-1-trade-1"]);
  await projector.runOnce();

  assert.equal(await countDocs(h.mongoUri, h.mongoDb, "box_daily_pnl"), 1, "still exactly one document");
  const doc = await findDoc(h.mongoUri, h.mongoDb, "box_daily_pnl", "pnl-day-1-trade-1");
  assert.equal(doc.data.net_pnl, 500, "P&L is not doubled");
});

test("projector: partial batch failure isolates the failing aggregate; others still publish", async (t) => {
  const h = await createHarness("partial");
  t.after(() => h.cleanup());

  // Good aggregate.
  await enqueueRow(h.pool, {
    eventId: "good-1", aggregateType: "box_trade", aggregateId: "good", eventType: "trade_opened", payload: { ok: true },
  });
  // Poison aggregate: unroutable aggregate_type -> dead-lettered, must not block "good".
  await enqueueRow(h.pool, {
    eventId: "bad-1", aggregateType: "not_a_collection", aggregateId: "bad", eventType: "x", payload: { ok: false },
  });

  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());

  const res = await projector.runOnce();
  assert.equal(res.published, 1, "the good aggregate published");
  assert.equal(res.deadLettered, 1, "the poison aggregate dead-lettered");

  const goodDoc = await findDoc(h.mongoUri, h.mongoDb, "box_trades", "good-1");
  assert.ok(goodDoc, "unrelated aggregate published despite the poison row");

  const { rows } = await h.pool.query(`SELECT dead_lettered_at FROM mongo_outbox WHERE event_id = $1`, ["bad-1"]);
  assert.ok(rows[0].dead_lettered_at, "poison row is dead-lettered, not blocking others");
});

test("projector: preserves per-aggregate ordering (OPENED before CLOSED even if claimed out of order)", async (t) => {
  const h = await createHarness("ordering");
  t.after(() => h.cleanup());

  // Enqueue OPENED then CLOSED so OPENED has the lower sequence.
  await enqueueRow(h.pool, {
    eventId: "trade-9-opened", aggregateType: "box_trade", aggregateId: "trade-9", eventType: "trade_opened",
    payload: { phase: "OPENED" },
  });
  await enqueueRow(h.pool, {
    eventId: "trade-9-closed", aggregateType: "box_trade", aggregateId: "trade-9", eventType: "trade_closed",
    payload: { phase: "CLOSED" },
  });

  // Make the OPENED row fail on first attempt by pointing the projector at Mongo,
  // but forcing the OPENED to error: we simulate this by making OPENED's payload
  // trip a transient error is hard; instead assert grouping+order directly.
  const { groupByAggregate } = await import("../../dist/outbox/projector.js");
  const claimed = [
    { event_id: "trade-9-closed", aggregate_type: "box_trade", aggregate_id: "trade-9", sequence: 2, payload: {}, event_type: "trade_closed", schema_version: 1, attempts: 0 },
    { event_id: "trade-9-opened", aggregate_type: "box_trade", aggregate_id: "trade-9", sequence: 1, payload: {}, event_type: "trade_opened", schema_version: 1, attempts: 0 },
  ];
  const groups = groupByAggregate(claimed);
  assert.equal(groups.length, 1, "same aggregate -> one group");
  assert.equal(groups[0][0].event_id, "trade-9-opened", "OPENED (lower sequence) applied first");
  assert.equal(groups[0][1].event_id, "trade-9-closed", "CLOSED second");

  // And end-to-end: after a drain, both are published and the CLOSED doc exists.
  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());
  const res = await projector.runOnce();
  assert.equal(res.published, 2);
  assert.ok(await findDoc(h.mongoUri, h.mongoDb, "box_trades", "trade-9-opened"));
  assert.ok(await findDoc(h.mongoUri, h.mongoDb, "box_trades", "trade-9-closed"));
});
