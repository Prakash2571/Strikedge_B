/**
 * D2 — THE ZERODHA ORDER-STREAM FLAG MUST GATE THE OBSERVATION PATH, NOT JUST A LABEL.
 *
 * The audit found the INVERSE of the usual defect: `ZERODHA_ORDER_STREAM_ENABLED` changed a
 * STATUS LABEL (orderStreamStatus → gated_off / rest_polling_only) but did NOT gate the
 * fill-observation path. Zerodha postbacks ride the box lane's quote socket as TEXT frames and
 * are forwarded to `engine.ingestBoxLaneOrderText`, which was guarded ONLY by consumer existence
 * (`if (!this.orderStreamConsumer) return`) — never by the env flag. So a postback resolved a
 * production order waiter EVEN WITH THE FLAG UNSET, while the status claimed fills were observed by
 * REST polling only. A flag that appears to control a capability it does not control is exactly the
 * dishonesty the brief forbids.
 *
 * DECISION: option (a) — the flag GENUINELY GATES the observation path. Unset ⇒ Zerodha text frames
 * are NOT consumed and fills are observed by REST polling only (the safe default and the verified
 * baseline). Set ⇒ postbacks are consumed and resolve waiters first, with REST as the reconciling
 * fallback. This makes the code match the meaning the docs already promised
 * (orderUpdates.ts: "OFF BY DEFAULT ... When off, ticker.ts keeps discarding text frames").
 *
 * This test proves the GATE lives on the observation path:
 *   1. REPRODUCTION (pre-fix behaviour): a stream observation resolves the REAL adapter waiter
 *      regardless of the flag, because the consumer's `streamEnabled` only drove HEALTH, not
 *      ingestion — the flag was not on the observation path at all.
 *   2. POST-FIX: the engine's text-frame gate (`zerodhaTextFramesConsumed`) returns false when the
 *      flag is unset, so `ingestBoxLaneOrderText` drops the frame and REST remains the only path.
 *
 * Real KiteBrokerAdapter + fake transport (no broker network) + injected clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter, stableKiteTag } from "../../dist/box/kiteBrokerAdapter.js";
import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { zerodhaTextFramesConsumed } from "../../dist/brokers/zerodha/orderUpdates.js";

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

/**
 * REPRODUCTION: with `streamEnabled: false` (the exact value the engine passes when the env flag is
 * unset), a stream observation STILL resolves the real waiter. This is the defect: the flag never
 * reached the observation path. The engine seam must be what actually gates consumption.
 */
test("D2 reproduction: the consumer's streamEnabled flag alone does NOT gate ingestion", async () => {
  const clock = makeClock();
  const transport = makeTransport();
  const adapter = new KiteBrokerAdapter(
    transport,
    { executionMode: "live", enabled: true, brokerMinIntervalMs: 1000, ackTimeoutMs: 60_000, workingTimeoutMs: 60_000, partialTimeoutMs: 60_000, cancelTimeoutMs: 5_000, maxChaseTicks: 3, maxModifications: 3 },
    clock,
  );
  const clientOrderId = "BOX:d2repro:ENTRY:k1_ce:attempt-1";
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter,
    streamEnabled: false, // the value passed when ZERODHA_ORDER_STREAM_ENABLED is UNSET
    now: () => clock.now(),
  });
  const tag = stableKiteTag(clientOrderId);
  consumer.registerIntent({ clientOrderId, ownerTag: tag, account: "AB1234", requestedQty: 75 });

  const submitted = adapter.submitOrder(orderRequest(clientOrderId));
  await Promise.resolve();
  await Promise.resolve();

  // Feed a stream observation exactly as ingestBoxLaneOrderText would AFTER parseKiteOrderFrame.
  consumer.ingestStreamObservation({
    ownerTag: tag, brokerOrderId: "K-1", account: "AB1234",
    cumulativeQty: 75, quantityPresent: true, averagePrice: 12.4, rawStatus: "COMPLETE", eventId: "K-1:done:75",
  });

  const order = await submitted;
  // The DEFECT: even with streamEnabled:false, the observation resolved the waiter on the stream.
  assert.equal(order.filled_quantity, 75);
  assert.equal(transport.getOrderCalls(), 0, "no REST poll — the stream observation resolved it despite the disabled flag");
});

/**
 * THE FIX: the engine consumes Zerodha text frames ONLY when the env flag is armed. This predicate
 * is the exact gate `ingestBoxLaneOrderText` applies before parsing/ingesting a frame.
 */
test("D2 fix: the text-frame observation gate is CLOSED when the flag is unset", () => {
  const prev = process.env.ZERODHA_ORDER_STREAM_ENABLED;
  try {
    delete process.env.ZERODHA_ORDER_STREAM_ENABLED;
    assert.equal(zerodhaTextFramesConsumed(), false, "unset means text frames are NOT consumed (REST-only)");
    process.env.ZERODHA_ORDER_STREAM_ENABLED = "false";
    assert.equal(zerodhaTextFramesConsumed(), false, "explicit false means REST-only");
    process.env.ZERODHA_ORDER_STREAM_ENABLED = "true";
    assert.equal(zerodhaTextFramesConsumed(), true, "armed means text frames are consumed");
  } finally {
    if (prev === undefined) delete process.env.ZERODHA_ORDER_STREAM_ENABLED;
    else process.env.ZERODHA_ORDER_STREAM_ENABLED = prev;
  }
});
