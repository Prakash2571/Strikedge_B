/**
 * REAL PRODUCTION WAITER — a stream event resolves the ACTUAL KiteBrokerAdapter order waiter
 * before its REST poll interval elapses.
 *
 * This is the load-bearing proof the task demands: NOT a test double, but the real
 * `KiteBrokerAdapter` with its real `submitOrder → waitForResolution` loop. The adapter is
 * driven with a fake transport (so no broker network) and an injected clock (so the REST poll
 * interval never elapses unless we advance it). We submit an order, block on the real waiter,
 * then deliver a stream fill through `applyOrderUpdate` — the same call the OrderStreamConsumer
 * makes in production — and prove the waiter resolves on the EVENT, with the REST getOrder poll
 * never having been reached.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { stableKiteTag } from "../../dist/box/kiteBrokerAdapter.js";

/** A deterministic clock: `wait(ms)` resolves only when `advance` passes its deadline. */
function makeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    wait(ms) { return new Promise((resolve) => timers.push({ at: t + ms, resolve })); },
    advance(ms) {
      t += ms;
      for (const d of timers.filter((x) => x.at <= t)) { timers.splice(timers.indexOf(d), 1); d.resolve(); }
    },
    pending: () => timers.length,
  };
}

/** A fake Kite transport that ACKs instantly and, by default, NEVER reports a fill via getOrder. */
function makeTransport({ onGetOrder } = {}) {
  let getOrderCalls = 0;
  const state = { order_id: "K-1", status: "OPEN", filled_quantity: 0, quantity: 75, average_price: 0, tag: null };
  return {
    getOrderCalls: () => getOrderCalls,
    async placeOrder(req, opts) { opts?.beforeSend?.(); state.tag = req.tag; return { order_id: "K-1" }; },
    async cancelOrder() {},
    async modifyOrder() {},
    async getOrder() {
      getOrderCalls++;
      // By default the REST path shows NO fill — so if the waiter resolves, it did so on the stream.
      return onGetOrder ? onGetOrder(state) : { ...state, order_id: "K-1", status: "OPEN", filled_quantity: 0 };
    },
    async listOrders() { return []; },
    async listPositions() { return []; },
    async health() { return { authenticated: true, message: null, checked_at: 0 }; },
  };
}

function orderRequest(clientOrderId) {
  return {
    client_order_id: clientOrderId,
    role: "k1_ce", purpose: "ENTRY", phase: "entry",
    exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE", token: 1001,
    side: "BUY", quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 12, tick_size: 0.05, max_chase_ticks: 3, limit_price: 12.15 },
  };
}

test("a stream fill resolves the REAL KiteBrokerAdapter waiter before the REST poll interval", async () => {
  const clock = makeClock();
  const transport = makeTransport();
  // A generous poll interval and ACK/working timeouts, so ONLY a stream event can resolve it early.
  const adapter = new KiteBrokerAdapter(
    transport,
    { executionMode: "live", enabled: true, brokerMinIntervalMs: 1000, ackTimeoutMs: 60_000, workingTimeoutMs: 60_000, partialTimeoutMs: 60_000, cancelTimeoutMs: 5_000, maxChaseTicks: 3, maxModifications: 3 },
    clock,
  );

  const clientOrderId = "BOX:realwaiter:ENTRY:k1_ce:attempt-1";
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter,
    streamEnabled: true,
    now: () => clock.now(),
  });
  // Ownership registered before the POST, keyed by the SAME stable tag the postback will echo.
  const tag = stableKiteTag(clientOrderId);
  consumer.registerIntent({ clientOrderId, ownerTag: tag, account: "AB1234", requestedQty: 75 });

  // Submit: this blocks on the REAL waitForResolution loop inside the adapter.
  const submitted = adapter.submitOrder(orderRequest(clientOrderId));

  // Let the adapter reach its first `waitOrObservation` (post-ACK). No time has been advanced, so
  // the 1000ms REST poll has NOT elapsed.
  await Promise.resolve();
  await Promise.resolve();

  // Deliver a full stream fill via the consumer — exactly the production path.
  consumer.ingestStreamObservation({
    ownerTag: tag, brokerOrderId: "K-1", account: "AB1234",
    cumulativeQty: 75, quantityPresent: true, averagePrice: 12.4, rawStatus: "COMPLETE", eventId: "K-1:done:75",
  });

  const order = await submitted;
  assert.equal(order.filled_quantity, 75, "the order completed on the stream event");
  assert.equal(order.state, "COMPLETE");
  assert.equal(transport.getOrderCalls(), 0, "the REST getOrder poll was NEVER reached — the stream woke the waiter");
  const stats = adapter.streamObservationStats();
  assert.ok(stats.applied >= 1, "the adapter recorded the external observation");
});

test("without a stream event, the SAME adapter waiter falls back to the REST poll (controlled fallback)", async () => {
  const clock = makeClock();
  // This time getOrder eventually reports the fill, proving REST remains a working fallback.
  const transport = makeTransport({
    onGetOrder: (s) => ({ ...s, order_id: "K-1", status: "COMPLETE", filled_quantity: 75, average_price: 12.4 }),
  });
  const adapter = new KiteBrokerAdapter(
    transport,
    { executionMode: "live", enabled: true, brokerMinIntervalMs: 1000, ackTimeoutMs: 60_000, workingTimeoutMs: 60_000, partialTimeoutMs: 60_000, cancelTimeoutMs: 5_000, maxChaseTicks: 3, maxModifications: 3 },
    clock,
  );
  const submitted = adapter.submitOrder(orderRequest("BOX:restfallback:ENTRY:k1_ce:attempt-1"));
  // No stream event. Drive the injected clock forward in poll-sized steps until the REST loop
  // has had a chance to park its waiter and refresh; a bounded number of steps keeps this from
  // hanging if the order never resolves.
  let order;
  for (let i = 0; i < 50 && order === undefined; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (clock.pending() > 0) clock.advance(1000);
    order = await Promise.race([submitted, Promise.resolve(undefined)]);
  }
  order = await submitted;
  assert.equal(order.filled_quantity, 75, "REST polling still resolves the order when no stream event arrives");
  assert.ok(transport.getOrderCalls() >= 1, "the REST poll WAS used as the fallback");
});
