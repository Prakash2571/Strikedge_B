/**
 * Secret hygiene at the projection boundary. Even if a secret-bearing payload
 * somehow reached the outbox table (bypassing the writer's enqueue-side guard),
 * the projector must refuse to write it to Mongo — `assertNoSecretFields` is the
 * second line of defence, applied immediately before every Mongo write.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, enqueueRow, countDocs } from "./helpers.mjs";
import { MongoExportClient } from "../../dist/outbox/mongo.js";
import { Projector } from "../../dist/outbox/projector.js";
import { assertNoSecretFields, OutboxSecretLeakError } from "../../dist/outbox/writer.js";

test("assertNoSecretFields throws on a payload carrying access_token (nested)", () => {
  assert.throws(
    () => assertNoSecretFields({ trade: { broker: { access_token: "secret" } } }),
    OutboxSecretLeakError,
  );
  // A clean payload passes.
  assert.doesNotThrow(() => assertNoSecretFields({ net_pnl: 1, legs: [{ price: 2 }] }));
});

test("projector refuses a secret-bearing row: it is NOT written to Mongo and is dead-lettered", async (t) => {
  const h = await createHarness("secrets");
  t.after(() => h.cleanup());

  // Directly insert a poisoned row that bypassed the writer guard (raw SQL, not enqueueOutbox).
  await h.pool.query(
    `INSERT INTO mongo_outbox (event_id, aggregate_type, aggregate_id, event_type, schema_version, sequence, payload)
     VALUES ($1,$2,$3,$4,$5,nextval('mongo_outbox_sequence_seq'),$6::jsonb)`,
    [
      "leak-1", "box_order_intent", "intent-x", "intent_transitioned", 1,
      JSON.stringify({ client_order_id: "abc", access_token: "kite_live_token_should_never_project" }),
    ],
  );
  // A clean sibling row that should still publish.
  await enqueueRow(h.pool, {
    eventId: "clean-1", aggregateType: "box_order_intent", aggregateId: "intent-y", eventType: "intent_transitioned",
    payload: { client_order_id: "def" },
  });

  const mongo = new MongoExportClient(h.exportConfig());
  const projector = new Projector(h.pool, mongo, { batchSize: 100, intervalMs: 50, maxBackoffMs: 60_000, maxAttempts: 5 });
  t.after(() => mongo.close());

  const res = await projector.runOnce();

  // The clean row published; the leaky row was refused (poison -> dead-lettered).
  assert.equal(res.published, 1, "clean row published");
  assert.equal(res.deadLettered, 1, "leaky row dead-lettered, never written");

  // Prove Mongo has exactly the clean doc and NOT the leaky one.
  assert.equal(await countDocs(h.mongoUri, h.mongoDb, "box_order_intents"), 1);
  const { rows } = await h.pool.query(
    `SELECT dead_lettered_at, last_error FROM mongo_outbox WHERE event_id = 'leak-1'`,
  );
  assert.ok(rows[0].dead_lettered_at, "leaky row is dead-lettered");
  // The bounded error names the field path but never echoes the token value.
  assert.ok(!String(rows[0].last_error).includes("kite_live_token_should_never_project"), "token value not leaked into last_error");
});
