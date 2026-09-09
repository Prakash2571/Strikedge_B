/**
 * DEFECT 2 — DHAN IMMEDIATE TERMINAL RESPONSE ACCOUNTING.
 *
 * `POST /orders` returning `{orderId, orderStatus:"TRADED"}` used to produce state COMPLETE with
 * filled_quantity 0 and NO subsequent order/trade read: a fully accounted execution invented from
 * a status label and a hardcoded zero. These tests prove that a placement response WITHOUT an
 * authoritative cumulative quantity and average price is NEVER accepted as a terminal execution —
 * the adapter must fetch evidence, keep uncertainty when it cannot, reconcile contradictions, and
 * keep cumulative fills monotonic.
 *
 * FAILING-FIRST: on the ORIGINAL dhanBrokerAdapter.ts these assertions fail because the immediate
 * TRADED collapses to COMPLETE-with-0. See EVIDENCE-transport.md.
 *
 * The fake DhanClient never touches the network; the adapter is the real one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";
import {
  BrokerAmbiguousSubmitError,
  BrokerOrderRejectedError,
} from "../../dist/box/brokerAdapter.js";

const REQUEST = {
  client_order_id: "BOX:6512f0a0a0a0a0a0a0a0a0a0:ENTRY:k1_ce:attempt-1",
  role: "k1_ce",
  trade_id: "6512f0a0a0a0a0a0a0a0a0a0",
  attempt_id: "attempt-1",
  purpose: "ENTRY",
  phase: "entry",
  exchange: "NFO",
  tradingsymbol: "ASTRAL25SEP2500CE",
  token: 2_000_045_678,
  side: "BUY",
  quantity: 275,
  pricing: { order_type: "LIMIT", reference_price: 12.5, tick_size: 0.05, max_chase_ticks: 2, limit_price: 12.6 },
};

/**
 * Build the real adapter over a scriptable fake DhanClient.
 *
 * `placedStatus` is what POST /orders returns. `orderBook`/`trades` are what the follow-up
 * getOrder / getTradesForOrder reads return, in sequence (last value repeats).
 */
function adapter({ placedStatus = "TRADED", orderReads = [], trades = [], getOrderThrows = false } = {}) {
  const calls = { place: 0, getOrder: 0, getTrades: 0, byCorrelation: 0 };
  const reads = [...orderReads];
  const client = {
    placeOrder: async (_req, opts) => { opts?.beforeSend?.(); calls.place++; return { orderId: "DHAN-1", orderStatus: placedStatus }; },
    getOrder: async () => {
      calls.getOrder++;
      if (getOrderThrows) throw new Error("order book unavailable");
      return reads.length > 1 ? reads.shift() : (reads[0] ?? null);
    },
    getOrderByCorrelationId: async () => { calls.byCorrelation++; return null; },
    getTradesForOrder: async () => { calls.getTrades++; return trades; },
    cancelOrder: async () => ({ orderId: "DHAN-1", orderStatus: "CANCELLED" }),
    modifyOrder: async () => ({ orderId: "DHAN-1", orderStatus: "PENDING" }),
    listOrders: async () => [],
    listPositions: async () => [],
    getFundLimit: async () => ({ availabelBalance: 1, utilizedAmount: 0 }),
    getProfile: async () => ({ dhanClientId: "C1" }),
  };
  const cfg = {
    executionMode: "live",
    enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 30,
    workingTimeoutMs: 60,
    partialTimeoutMs: 30,
    cancelTimeoutMs: 30,
    brokerMinIntervalMs: 1,
    maxModifications: 2,
    maxChaseTicks: 2,
    dhanClientId: () => "C1",
    identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
  };
  return { a: new DhanBrokerAdapter(client, cfg), calls };
}

const dhanOrder = (o) => ({
  orderId: "DHAN-1",
  tradingSymbol: "ASTRAL25SEP2500CE",
  securityId: "45678",
  exchangeSegment: "NSE_FNO",
  transactionType: "BUY",
  price: 12.6,
  quantity: 275,
  ...o,
});

test("an immediate TRADED with NO cumulative quantity is NOT a COMPLETE-with-0 execution", { timeout: 5000 }, async () => {
  // The POST says TRADED but carries no qty/price. The follow-up read confirms the real fill.
  const { a, calls } = adapter({
    placedStatus: "TRADED",
    orderReads: [dhanOrder({ orderStatus: "TRADED", filledQty: 275, averageTradedPrice: 12.55 })],
  });
  const order = await a.submitOrder(REQUEST);
  assert.equal(order.state, "COMPLETE");
  assert.equal(order.filled_quantity, 275, "the quantity came from an order/trade read, not the label");
  assert.equal(order.average_price, 12.55);
  assert.ok(calls.getOrder >= 1, "authoritative evidence was actually fetched");
  // The core regression: it must NOT be COMPLETE with a zero fill.
  assert.ok(!(order.state === "COMPLETE" && order.filled_quantity === 0), "never COMPLETE-with-0");
});

test("a TRADED placement whose evidence CANNOT be obtained stays UNCERTAIN, not COMPLETE", { timeout: 5000 }, async () => {
  const { a } = adapter({ placedStatus: "TRADED", getOrderThrows: true });
  const err = await a.submitOrder(REQUEST).then(() => null, (e) => e);
  assert.ok(err instanceof BrokerAmbiguousSubmitError, "unproven execution is surfaced as ambiguous/uncertain");
  assert.equal(err.order.state, "RECONCILIATION_REQUIRED", "blocks dependent entries rather than guessing COMPLETE");
  assert.notEqual(err.order.state, "COMPLETE");
});

test("a TRADED label with a SHORT verified fill is PARTIALLY_FILLED, never COMPLETE", { timeout: 5000 }, async () => {
  // First read shows a short fill; without a terminal read the working deadline forces a
  // protective cancel path, but the fill is real and must be carried — never rounded up.
  const { a } = adapter({
    placedStatus: "TRADED",
    orderReads: [
      dhanOrder({ orderStatus: "PART_TRADED", filledQty: 100, averageTradedPrice: 12.55, remainingQuantity: 175 }),
      dhanOrder({ orderStatus: "CANCELLED", filledQty: 100, averageTradedPrice: 12.55, remainingQuantity: 0 }),
    ],
  });
  const order = await a.submitOrder(REQUEST);
  assert.equal(order.filled_quantity, 100, "a partial must never be rounded into a full box");
  assert.ok(order.state === "CANCELLED" || order.state === "PARTIALLY_FILLED" || order.state === "RECONCILIATION_REQUIRED");
  assert.ok(!(order.state === "COMPLETE" && order.filled_quantity < 275));
});

test("a CANCELLED placement with a NONZERO verified fill is reconciled, not treated as flat", { timeout: 5000 }, async () => {
  // Contradiction: CANCELLED label but a real partial fill. The observed quantity wins.
  const { a } = adapter({
    placedStatus: "CANCELLED",
    orderReads: [dhanOrder({ orderStatus: "CANCELLED", filledQty: 75, averageTradedPrice: 12.5, remainingQuantity: 200 })],
  });
  const order = await a.submitOrder(REQUEST);
  assert.equal(order.filled_quantity, 75, "a cancelled-with-a-fill keeps its real exposure");
  assert.equal(order.state, "CANCELLED");
});

test("a REJECTED placement with a CONFIRMED zero fill is a clean rejection", { timeout: 5000 }, async () => {
  const { a } = adapter({
    placedStatus: "REJECTED",
    orderReads: [dhanOrder({ orderStatus: "REJECTED", filledQty: 0, omsErrorDescription: "RMS: blocked" })],
  });
  await assert.rejects(() => a.submitOrder(REQUEST), BrokerOrderRejectedError);
});

test("a delayed order book (TRADED visible only on the second read) is still accounted from evidence", { timeout: 5000 }, async () => {
  const { a, calls } = adapter({
    placedStatus: "TRADED",
    // First read: still working with no fill. Second read: the trade is visible.
    orderReads: [
      dhanOrder({ orderStatus: "PENDING", filledQty: 0, remainingQuantity: 275 }),
      dhanOrder({ orderStatus: "TRADED", filledQty: 275, averageTradedPrice: 12.6 }),
    ],
  });
  const order = await a.submitOrder(REQUEST);
  assert.equal(order.state, "COMPLETE");
  assert.equal(order.filled_quantity, 275);
  assert.ok(calls.getOrder >= 2, "the adapter polled until the fill became visible");
});
