/**
 * DEFECT B — UNIVERSAL DHAN EXECUTION-EVIDENCE VALIDATION.
 *
 * The placement-response path was already guarded (`hasAuthoritativeQuantity`, see
 * defect2DhanTerminalAccounting.test.mjs). Every OTHER observation path still funnelled through
 * `project()`, which did:
 *
 *     const filled = numberOr(remote.filledQty, 0);              // MISSING becomes ZERO
 *     average_price: numberOrNull(remote.averageTradedPrice),     // MISSING becomes null…
 *     …fills: [{ quantity: filled, price: numberOr(remote.averageTradedPrice, 0) }]  // …then ZERO
 *
 * REPRODUCED ON e357b83:
 *   B1  a REST poll observing PENDING → TRADED with NO `filledQty` yields COMPLETE, filled 0 —
 *       a fully accounted terminal execution invented from a status label.
 *   B2  TRADED with a real `filledQty` but NO `averageTradedPrice` yields a fill priced at ZERO,
 *       which is fabricated P&L, not missing data.
 *   B3  CANCELLED with NO `filledQty` is accepted as a CONFIRMED zero, so a fill the broker never
 *       reported on is treated as proof that nothing executed.
 *   B4  the same holds on the restart/reconciliation paths (`listOrders` orphan projection).
 *
 * THE CONTRACT UNDER TEST is the distinction between a MISSING field and an EXPLICITLY CONFIRMED
 * ZERO. Missing evidence keeps the order UNCERTAIN. Confirmed quantity establishes exposure even
 * when price enrichment is pending, and must not be blocked from reduction — but it must never
 * produce a priced fill the broker did not report.
 *
 * The fake DhanClient never touches the network; the adapter under test is the real one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";
import { KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import {
  executionAccountingComplete,
  readCumulativeQuantity,
  readTradedPrice,
  evaluateExecutionEvidence,
} from "../../dist/box/brokerExecutionEvidence.js";

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

/** The real adapter over a scriptable fake client. `orderReads` are consumed in sequence. */
function adapter({ placedStatus = "PENDING", orderReads = [], trades = [], listed = [] } = {}) {
  const reads = [...orderReads];
  const calls = { place: 0, getOrder: 0, cancel: 0 };
  const client = {
    placeOrder: async (_req, opts) => { opts?.beforeSend?.(); calls.place++; return { orderId: "DHAN-1", orderStatus: placedStatus }; },
    getOrder: async () => { calls.getOrder++; return reads.length > 1 ? reads.shift() : (reads[0] ?? null); },
    getOrderByCorrelationId: async () => null,
    getTradesForOrder: async () => trades,
    cancelOrder: async () => { calls.cancel++; return { orderId: "DHAN-1", orderStatus: "CANCELLED" }; },
    modifyOrder: async () => ({ orderId: "DHAN-1", orderStatus: "PENDING" }),
    listOrders: async () => listed,
    listPositions: async () => [],
    getFundLimit: async () => ({ availabelBalance: 1, utilizedAmount: 0 }),
    getProfile: async () => ({ dhanClientId: "C1" }),
  };
  const cfg = {
    executionMode: "live",
    enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 20,
    workingTimeoutMs: 40,
    partialTimeoutMs: 20,
    cancelTimeoutMs: 20,
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

const settle = (promise) => promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

/* ─────────── B1: TRADED with a MISSING cumulative quantity ─────────── */

test("defect B1 — a polled TRADED with NO filledQty is never COMPLETE-with-zero", { timeout: 5_000 }, async () => {
  const { a } = adapter({
    placedStatus: "PENDING",
    // Working, then a terminal-looking label that carries NO cumulative quantity at all.
    orderReads: [dhanOrder({ orderStatus: "PENDING" }), dhanOrder({ orderStatus: "TRADED" })],
  });

  const outcome = await settle(a.submitOrder(REQUEST));
  const order = outcome.ok ? outcome.v : outcome.e.order;
  assert.ok(order, "the adapter must surface an order either way");
  assert.notEqual(order.state, "COMPLETE", "a label with no quantity is not an accounted execution");
  assert.ok(
    order.state === "RECONCILIATION_REQUIRED" || order.state === "UNKNOWN",
    `insufficient evidence must remain uncertain, got ${order.state}`,
  );
  assert.equal(
    executionAccountingComplete(order), false,
    "accounting cannot be complete without a reported cumulative quantity",
  );
});

/* ─────────── B2: quantity confirmed, price still missing ─────────── */

test("defect B2 — a confirmed quantity with NO average price establishes exposure but fabricates no price", { timeout: 5_000 }, async () => {
  const { a } = adapter({
    placedStatus: "PENDING",
    orderReads: [
      dhanOrder({ orderStatus: "PENDING", filledQty: 0 }),
      // Real cumulative quantity, price enrichment not yet published.
      dhanOrder({ orderStatus: "TRADED", filledQty: 275 }),
    ],
  });

  const outcome = await settle(a.submitOrder(REQUEST));
  const order = outcome.ok ? outcome.v : outcome.e.order;

  assert.equal(order.filled_quantity, 275, "confirmed quantity MUST establish exposure");
  assert.equal(order.average_price, null, "an unreported price stays null, never zero");
  for (const fill of order.fills) {
    assert.notEqual(fill.price, 0, "a fill priced at zero is fabricated P&L, not missing data");
    assert.equal(fill.price, null, "an unpriced fill must say so explicitly");
  }
  assert.equal(
    executionAccountingComplete(order), false,
    "exposure is real but the accounting is not complete until the price arrives",
  );
});

/* ─────────── B3: CANCELLED with a MISSING quantity ─────────── */

test("defect B3 — a CANCELLED with NO filledQty is not a confirmed zero", { timeout: 5_000 }, async () => {
  const { a } = adapter({
    placedStatus: "PENDING",
    orderReads: [dhanOrder({ orderStatus: "PENDING", filledQty: 0 }), dhanOrder({ orderStatus: "CANCELLED" })],
  });

  const outcome = await settle(a.submitOrder(REQUEST));
  const order = outcome.ok ? outcome.v : outcome.e.order;
  assert.notEqual(order.state, "CANCELLED", "silence about quantity is not proof that nothing filled");
  assert.ok(
    order.state === "RECONCILIATION_REQUIRED" || order.state === "UNKNOWN",
    `an unquantified cancellation must remain uncertain, got ${order.state}`,
  );
});

test("defect B3b — a CANCELLED with an EXPLICIT zero IS a confirmed zero", { timeout: 5_000 }, async () => {
  const { a } = adapter({
    placedStatus: "PENDING",
    orderReads: [dhanOrder({ orderStatus: "PENDING", filledQty: 0 }), dhanOrder({ orderStatus: "CANCELLED", filledQty: 0 })],
  });

  const outcome = await settle(a.submitOrder(REQUEST));
  const order = outcome.ok ? outcome.v : outcome.e.order;
  assert.equal(order.state, "CANCELLED", "an explicitly reported zero is authoritative");
  assert.equal(order.filled_quantity, 0);
  assert.equal(executionAccountingComplete(order), true, "a confirmed zero fill needs no price");
});

/* ─────────── B4: the restart / reconciliation projection ─────────── */

test("defect B4 — an orphan order with NO filledQty is surfaced as uncertain, not as flat", { timeout: 5_000 }, async () => {
  const { a } = adapter({
    listed: [dhanOrder({ orderId: "DHAN-ORPHAN", orderStatus: "TRADED", correlationId: "zz" })],
  });
  const orders = await a.listOrders();
  assert.equal(orders.length, 1);
  assert.notEqual(orders[0].state, "COMPLETE", "an unquantified orphan must not be read as fully executed");
  assert.ok(
    orders[0].state === "RECONCILIATION_REQUIRED" || orders[0].state === "UNKNOWN",
    `got ${orders[0].state}`,
  );
});

/* ─────────── B5: the same rules on the Zerodha projection ─────────── */

const kiteRequest = {
  client_order_id: "BOX:trade-1:ENTRY:k1_ce:attempt-1",
  role: "k1_ce", trade_id: "trade-1", attempt_id: "attempt-1", purpose: "ENTRY", phase: "entry",
  exchange: "NFO", tradingsymbol: "NIFTY26SEP19900CE", token: 1001, side: "BUY", quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
};

function kiteAdapter(states) {
  const queue = [...states];
  const transport = {
    placeOrder: async (_p, opts) => { opts?.beforeSend?.(); return { order_id: "K1" }; },
    cancelOrder: async () => {},
    modifyOrder: async () => {},
    getOrder: async () => queue.length > 1 ? queue.shift() : (queue[0] ?? null),
    listOrders: async () => [],
    listPositions: async () => [],
    margins: async () => ({ available: 1, utilised: 0 }),
    health: async () => ({ ok: true, transport: "up", authenticated: true, message: null, checked_at: 0 }),
  };
  let now = 0;
  return new KiteBrokerAdapter(transport, {
    executionMode: "live", enabled: true,
    ackTimeoutMs: 40, workingTimeoutMs: 60, partialTimeoutMs: 40, cancelTimeoutMs: 40,
    brokerMinIntervalMs: 1, maxModifications: 2, maxChaseTicks: 2,
  }, { now: () => now, wait: async (ms) => { now += ms; } });
}

const kiteRow = (o) => ({
  order_id: "K1", status: "COMPLETE", exchange: "NFO", tradingsymbol: "NIFTY26SEP19900CE",
  transaction_type: "BUY", quantity: 75, pending_quantity: 0, price: 100.1, tag: "BOXTAG",
  status_message: null, order_timestamp: null, exchange_update_timestamp: null, ...o,
});

test("defect B5 — a Zerodha COMPLETE with NO filled_quantity is not COMPLETE-with-zero", { timeout: 5_000 }, async () => {
  // `filled_quantity` omitted entirely, as an incomplete postback/JSON payload would arrive.
  const a = kiteAdapter([kiteRow({ status: "COMPLETE", average_price: 100.05 })]);
  const outcome = await settle(a.submitOrder(kiteRequest));
  const order = outcome.ok ? outcome.v : outcome.e.order;
  assert.ok(order, "an order must be surfaced either way");
  assert.notEqual(order.state, "COMPLETE", "a status label alone is not an execution record");
  assert.equal(executionAccountingComplete(order), false);
});

test("defect B5b — a Zerodha COMPLETE with a quantity but NO price keeps exposure and no fabricated price", { timeout: 5_000 }, async () => {
  const a = kiteAdapter([kiteRow({ status: "COMPLETE", filled_quantity: 75, average_price: 0 })]);
  const outcome = await settle(a.submitOrder(kiteRequest));
  const order = outcome.ok ? outcome.v : outcome.e.order;
  assert.equal(order.filled_quantity, 75, "confirmed quantity establishes exposure");
  assert.equal(order.average_price, null, "zero is a placeholder, not a traded option price");
  for (const fill of order.fills) assert.equal(fill.price, null);
  assert.equal(executionAccountingComplete(order), false);
});

/* ─────────── B6: the pure evidence reader ─────────── */

test("readCumulativeQuantity separates MISSING from an explicitly confirmed zero", () => {
  assert.deepEqual(readCumulativeQuantity({}), { value: null, present: false });
  assert.deepEqual(readCumulativeQuantity({ filledQty: undefined }), { value: null, present: false });
  assert.deepEqual(readCumulativeQuantity({ filledQty: null }), { value: null, present: false });
  assert.deepEqual(readCumulativeQuantity({ filledQty: "" }), { value: null, present: false });
  assert.deepEqual(readCumulativeQuantity({ filledQty: "abc" }), { value: null, present: false });
  assert.deepEqual(readCumulativeQuantity({ filledQty: 0 }), { value: 0, present: true });
  assert.deepEqual(readCumulativeQuantity({ filledQty: "0" }), { value: 0, present: true });
  assert.deepEqual(readCumulativeQuantity({ filledQty: 275 }), { value: 275, present: true });
  assert.deepEqual(readCumulativeQuantity({ filledQty: -1 }), { value: null, present: false },
    "a negative cumulative quantity is not evidence");
});

test("readTradedPrice treats an absent, zero or nonsense price as unreported", () => {
  assert.deepEqual(readTradedPrice({}), { value: null, present: false });
  assert.deepEqual(readTradedPrice({ averageTradedPrice: null }), { value: null, present: false });
  assert.deepEqual(readTradedPrice({ averageTradedPrice: 0 }), { value: null, present: false },
    "an option cannot trade at zero, so 0 is a placeholder rather than a price");
  assert.deepEqual(readTradedPrice({ averageTradedPrice: 12.55 }), { value: 12.55, present: true });
});

test("evaluateExecutionEvidence keeps a terminal claim uncertain without a cumulative quantity", () => {
  const base = { requestedQuantity: 275, priorFilled: 0 };
  const missing = evaluateExecutionEvidence({
    ...base, statusLabel: "TRADED", claimedState: "COMPLETE",
    quantity: { value: null, present: false }, price: { value: null, present: false },
  });
  assert.equal(missing.sufficient, false);
  assert.match(missing.detail, /cumulative/i);

  const priced = evaluateExecutionEvidence({
    ...base, statusLabel: "TRADED", claimedState: "COMPLETE",
    quantity: { value: 275, present: true }, price: { value: 12.55, present: true },
  });
  assert.equal(priced.sufficient, true);
  assert.equal(priced.filledQuantity, 275);
  assert.equal(priced.averagePrice, 12.55);
  assert.equal(priced.accountingComplete, true);

  const unpriced = evaluateExecutionEvidence({
    ...base, statusLabel: "TRADED", claimedState: "COMPLETE",
    quantity: { value: 275, present: true }, price: { value: null, present: false },
  });
  assert.equal(unpriced.sufficient, true, "quantity alone establishes exposure");
  assert.equal(unpriced.filledQuantity, 275);
  assert.equal(unpriced.averagePrice, null);
  assert.equal(unpriced.accountingComplete, false, "but the accounting is not complete");

  // A working label needs no terminal proof: it is not freezing any accounting.
  const working = evaluateExecutionEvidence({
    ...base, statusLabel: "PENDING", claimedState: "OPEN",
    quantity: { value: null, present: false }, price: { value: null, present: false },
  });
  assert.equal(working.sufficient, true);
  assert.equal(working.filledQuantity, 0, "no fill evidence on a working order is not a fabricated terminal zero");

  // Never regress a cumulative quantity already observed.
  const regressed = evaluateExecutionEvidence({
    statusLabel: "TRADED", claimedState: "COMPLETE", requestedQuantity: 275, priorFilled: 275,
    quantity: { value: 100, present: true }, price: { value: 12.55, present: true },
  });
  assert.equal(regressed.filledQuantity, 275, "a later lower cumulative quantity must not rewrite exposure down");
});
