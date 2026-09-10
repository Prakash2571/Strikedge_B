/**
 * PROCESS RESTART WITH LIVE WORKING ORDERS — order-stream ownership survives a restart, against a
 * REAL PostgreSQL.
 *
 * THE SCENARIO the task requires: a live working order exists durably when the process restarts.
 * After restart the order-stream consumer must be able to attribute an incoming order-update to
 * that order — which is only possible if ownership is rebuilt from the DURABLE intent (the stable
 * strategy key / correlation id and the broker order id), not from lost in-memory state.
 *
 * This test drives the REAL repository: it persists a working intent, then simulates a restart by
 * constructing a FRESH OrderStreamConsumer (as a new process would) and re-registering it from the
 * durable intent — exactly the adoption a reconcile sweep performs — and proves a subsequent stream
 * event attributes and applies. It also proves the pre-restart in-memory ledger is genuinely gone,
 * so the durable rebuild is doing the work.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseIntent, audit } from "./helpers.mjs";

let ctx;
let repo;
let OrderStreamConsumer;

test.before(async () => {
  ctx = await setup("streamrestart");
  repo = await loadRepository();
  ({ OrderStreamConsumer } = await import("../../dist/box/orderStreamConsumer.js"));
});
test.after(async () => { await teardown(ctx); });

/** A minimal adapter with a session snapshot the stream can wake — the restart rebuilds it too. */
class RealishAdapter {
  constructor() { this.orders = new Map(); this.applied = 0; }
  register(clientOrderId, quantity, brokerOrderId) {
    this.orders.set(clientOrderId, { client_order_id: clientOrderId, broker_order_id: brokerOrderId, quantity, filled_quantity: 0, state: "OPEN" });
  }
  applyOrderUpdate(update) {
    const known = this.orders.get(update.clientOrderId);
    if (!known) return undefined;
    const q = update.cumulativeQty;
    if (q === undefined || q === null || q < known.filled_quantity) return { ...known };
    known.filled_quantity = q;
    if (q >= known.quantity) known.state = "COMPLETE";
    this.applied++;
    return { ...known };
  }
}

test("a working order persisted before a restart is re-adopted and its stream fill attributes", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k1_ce:a1`;
  const tag = "BOXWORK1";
  // ── BEFORE THE RESTART: a live working order is durable, with its stable tag and broker id. ──
  const intent = baseIntent({
    client_order_id: coid,
    state: "OPEN",
    broker_order_id: "B-REST-1",
    broker_tag: tag,
    filled_quantity: 30,
  });
  await repo.createBoxOrderIntent(intent);
  await repo.updateBoxOrderIntent(coid, { state: "OPEN", broker_order_id: "B-REST-1", filled_quantity: 30 }, audit("OPEN"));

  // The pre-restart consumer had a ledger; the restart discards it (a new process, new memory).
  const preRestart = new OrderStreamConsumer({ broker: "zerodha", account: () => "AB1234", adapter: new RealishAdapter(), streamEnabled: true, now: () => 1000 });
  preRestart.registerIntent({ clientOrderId: coid, ownerTag: tag, account: "AB1234", requestedQty: 75, brokerOrderId: "B-REST-1" });
  assert.ok(preRestart.projection().hasOrder(coid));

  // ── THE RESTART: a brand-new consumer + adapter, with NO memory of the pre-restart ledger. ──
  const adapter = new RealishAdapter();
  const consumer = new OrderStreamConsumer({ broker: "zerodha", account: () => "AB1234", adapter, streamEnabled: true, now: () => 2000 });
  // A fresh consumer knows nothing until it rebuilds from durable state.
  assert.equal(consumer.projection().hasOrder(coid), false, "the new process starts with an empty projection");

  // ADOPTION FROM DURABLE STATE — exactly what the reconcile sweep does on boot: load the durable
  // nonterminal intents and re-register their ownership (tag + broker order id + prior fill).
  const durable = await repo.findBoxOrderIntentByClientId(coid);
  assert.equal(durable.state, "OPEN");
  assert.equal(durable.broker_order_id, "B-REST-1");
  consumer.registerIntent({
    clientOrderId: durable.client_order_id,
    ownerTag: durable.broker_tag,
    account: "AB1234",
    requestedQty: durable.quantity,
    brokerOrderId: durable.broker_order_id,
  });
  adapter.register(durable.client_order_id, durable.quantity, durable.broker_order_id);
  // Seed the rebuilt ledger to the durable prior fill via a reconciliation observation (no gap loss).
  consumer.ingestRestObservation({ ownerTag: durable.broker_tag, account: "AB1234", cumulativeQty: durable.filled_quantity, quantityPresent: true, eventId: "recon:30" }, "reconciliation");
  assert.equal(consumer.projection().ledger(coid).cumulative, 30, "the durable prior fill is restored after restart");

  // Now a POST-restart order-update completes the order — attributed by the DURABLE tag/broker id.
  const byTag = consumer.ingestStreamObservation({ ownerTag: tag, brokerOrderId: "B-REST-1", account: "AB1234", cumulativeQty: 75, quantityPresent: true, rawStatus: "COMPLETE", eventId: "post:75" });
  assert.equal(byTag.attributed, true, "the post-restart event attributes to the re-adopted order");
  assert.equal(consumer.projection().ledger(coid).cumulative, 75);
  assert.equal(adapter.orders.get(coid).filled_quantity, 75, "the rebuilt adapter snapshot reflects completion");
  assert.equal(adapter.orders.get(coid).state, "COMPLETE");

  // And a late event carrying ONLY the broker id (no tag) still attributes after restart.
  const byBrokerId = consumer.ingestStreamObservation({ ownerTag: "", brokerOrderId: "B-REST-1", account: "AB1234", cumulativeQty: 75, quantityPresent: true, eventId: "post:dup75" });
  assert.equal(byBrokerId.attributed, true, "broker-id-only attribution survives the restart too");
});
