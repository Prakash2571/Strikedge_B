/**
 * Resilience: MongoDB Atlas is a reporting replica, never on the execution hot
 * path. These tests prove a Mongo outage cannot fail, delay or block an
 * operational PostgreSQL transaction, and that the projector's backlog simply
 * grows without throwing. They also cover the status snapshot and dead-letter
 * visibility.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, enqueueRow } from "./helpers.mjs";
import { MongoExportClient } from "../../dist/outbox/mongo.js";
import { Projector } from "../../dist/outbox/projector.js";
import { getExportStatus, resetProjectorRuntimeState } from "../../dist/outbox/status.js";

/** A config pointed at a black hole so any Mongo op fails fast. */
function deadMongoConfig() {
  return {
    enabled: true,
    // Reserved TEST-NET address (RFC 5737) — nothing listens; server selection times out.
    uri: "mongodb://192.0.2.1:1/strikedge_dead",
    dbName: "strikedge_dead",
    batchSize: 100,
    intervalMs: 50,
    maxBackoffMs: 60_000,
    serverSelectionTimeoutMs: 800,
    maxAttempts: 5,
  };
}

test("LOAD-BEARING: a Mongo outage does NOT block a protective PostgreSQL transaction", async (t) => {
  const h = await createHarness("outage_hotpath");
  t.after(() => h.cleanup());

  // Start a projector against a DEAD Mongo. Its drain will fail every tick.
  const mongo = new MongoExportClient(deadMongoConfig());
  const projector = new Projector(h.pool, mongo, {
    batchSize: 100, intervalMs: 25, maxBackoffMs: 60_000, maxAttempts: 5,
  });
  t.after(() => mongo.close());
  projector.start();
  t.after(() => projector.stop());

  // Meanwhile, simulate an OPERATIONAL protective transaction that enqueues an
  // outbox row while Mongo is down. It must commit promptly and independently.
  const start = Date.now();
  const client = await h.pool.connect();
  try {
    await client.query("BEGIN");
    await enqueueRow(client, {
      eventId: "protective-exit-1",
      aggregateType: "box_order_intent",
      aggregateId: "intent-1",
      eventType: "protective_cancel",
      payload: { purpose: "PROTECTIVE_CANCEL" },
    });
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  const elapsed = Date.now() - start;

  // The operational transaction must not have waited on Mongo's server-selection
  // timeout. Generous bound (Mongo timeout is 800ms) but far below it.
  assert.ok(elapsed < 500, `operational tx committed promptly (${elapsed}ms), independent of the Mongo outage`);

  // The row is durably committed and still pending (Mongo is down, so the drain
  // could not publish it) — the backlog grew, nothing threw.
  const { rows } = await h.pool.query(
    `SELECT published_at, dead_lettered_at FROM mongo_outbox WHERE event_id = $1`,
    ["protective-exit-1"],
  );
  assert.equal(rows.length, 1, "the enqueued row is durably committed");
  assert.equal(rows[0].published_at, null, "still unpublished — Mongo is down");
});

test("Mongo unavailable: backlog grows, nothing throws, further PG writes keep succeeding", async (t) => {
  const h = await createHarness("outage_backlog");
  t.after(() => h.cleanup());

  const mongo = new MongoExportClient(deadMongoConfig());
  const projector = new Projector(h.pool, mongo, {
    batchSize: 100, intervalMs: 25, maxBackoffMs: 60_000, maxAttempts: 5,
  });
  t.after(() => mongo.close());

  // Enqueue several rows, then attempt to drain against dead Mongo. runOnce must
  // resolve (never throw) with zero published.
  for (let i = 0; i < 5; i++) {
    await enqueueRow(h.pool, {
      eventId: `bl-${i}`, aggregateType: "box_trade", aggregateId: `t-${i}`, eventType: "trade_opened", payload: { i },
    });
  }
  const res = await projector.runOnce();
  assert.equal(res.published, 0, "nothing published while Mongo is down");
  assert.ok(res.claimed >= 1, "rows were claimed and attempted");

  // Subsequent PG writes still succeed — the outbox is not wedged.
  await enqueueRow(h.pool, {
    eventId: "bl-after", aggregateType: "box_trade", aggregateId: "t-after", eventType: "trade_opened", payload: {},
  });
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM mongo_outbox WHERE published_at IS NULL`);
  assert.equal(rows[0].n, 6, "backlog grew to 6, nothing lost");

  // Attempts were incremented and a bounded error recorded (no SQL / creds leaked).
  const { rows: errRows } = await h.pool.query(
    `SELECT attempts, last_error FROM mongo_outbox WHERE event_id = 'bl-0'`,
  );
  assert.ok(errRows[0].attempts >= 1, "attempts incremented");
  assert.ok(errRows[0].last_error && errRows[0].last_error.length <= 500, "error bounded <=500 chars");
});

test("status snapshot reports backlog, dead-letters and stays secret-free; dead-letter does not block later rows", async (t) => {
  const h = await createHarness("status_deadletter");
  t.after(() => h.cleanup());
  resetProjectorRuntimeState();

  // A poison row (unroutable) that will dead-letter, followed by a good row behind it.
  await enqueueRow(h.pool, {
    eventId: "poison-1", aggregateType: "unknown_agg", aggregateId: "p", eventType: "x", payload: {},
  });
  await enqueueRow(h.pool, {
    eventId: "behind-1", aggregateType: "box_trade", aggregateId: "b", eventType: "trade_opened", payload: { ok: 1 },
  });

  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());

  const res = await projector.runOnce();
  assert.equal(res.deadLettered, 1, "poison row dead-lettered");
  assert.equal(res.published, 1, "the row behind it still published");

  const status = await getExportStatus(h.pool, true);
  assert.equal(status.enabled, true);
  assert.equal(status.deadLettered, 1, "status shows the dead letter");
  assert.equal(status.publishedTotal, 1);
  assert.equal(status.backlog, 0, "nothing pending: one published, one dead-lettered");
  assert.ok(typeof status.lastError === "string" || status.lastError === null);
  // Secret hygiene: the snapshot is a fixed set of scalar fields; assert no obvious secret keys.
  const json = JSON.stringify(status);
  for (const forbidden of ["access_token", "mongodb_uri", "password", "passcode", "connection_string"]) {
    assert.ok(!json.toLowerCase().includes(forbidden), `status must not contain ${forbidden}`);
  }
});

test("dead-lettered row is replayable by hand (clearing dead_lettered_at re-drains it)", async (t) => {
  const h = await createHarness("replay");
  t.after(() => h.cleanup());

  // Force a dead-letter by exhausting a tiny attempt budget against dead Mongo.
  await enqueueRow(h.pool, {
    eventId: "retry-me", aggregateType: "box_trade", aggregateId: "r", eventType: "trade_opened", payload: { ok: 1 },
  });
  const dead = new MongoExportClient(deadMongoConfig());
  const budget1 = new Projector(h.pool, dead, { batchSize: 100, intervalMs: 25, maxBackoffMs: 1, maxAttempts: 2 });
  t.after(() => dead.close());
  // Two passes exhaust maxAttempts=2 (backoff clamped to 1ms so it's due again).
  await budget1.runOnce();
  await new Promise((r) => setTimeout(r, 10));
  await budget1.runOnce();
  const { rows: d } = await h.pool.query(`SELECT dead_lettered_at FROM mongo_outbox WHERE event_id='retry-me'`);
  assert.ok(d[0].dead_lettered_at, "row exhausted budget and dead-lettered");

  // Hand replay: clear dead_lettered_at + reset next_attempt_at, drain against LIVE Mongo.
  await h.pool.query(
    `UPDATE mongo_outbox SET dead_lettered_at = NULL, next_attempt_at = clock_timestamp(), attempts = 0 WHERE event_id = 'retry-me'`,
  );
  const live = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, live, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => live.close());
  const res = await projector.runOnce();
  assert.equal(res.published, 1, "replayed row published on retry");
});
