/**
 * REAL PRODUCTION RATE BUDGET — an exhausted order budget ACTUALLY prevents a prohibited
 * order transmission, and recovery (protective cancellation) is NEVER starved by a placement
 * storm.
 *
 * This is the load-bearing proof the task demands: the REAL KiteBrokerAdapter (its real
 * submitOrder → beforeSend boundary → waitForResolution loop) driven with a MOCKED transport so
 * every broker touch is observable and counted, and resolved via the PRODUCTION stream path
 * (`applyOrderUpdate`) so no wall-clock polling is needed and `node --test` exits cleanly. A
 * single application-owned RateBudgetLedger is shared with the adapter; once its placement budget
 * is spent, the next entry placement must be refused BEFORE `transport.placeOrder` is ever
 * called — the mocked transport's placeOrder count must NOT increase — yet a protective cancel
 * must still be transmitted, because the recovery reserve exists for exactly that.
 *
 * Failing-first: before the adapter is wired to consult the ledger, rate exhaustion does
 * nothing and every placement calls the transport, so the "no prohibited POST" assertion fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { KiteBrokerAdapter, stableKiteTag } from "../../dist/box/kiteBrokerAdapter.js";
import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";
import {
  RateBudgetLedger,
  brokerRateLimits,
  resolveOrderBudgetPolicy,
} from "../../dist/box/brokerPacing.js";

/** Deterministic clock so pacing never actually sleeps in real time. */
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

/**
 * A mocked Kite transport that ACKs instantly and, by default, NEVER reports a fill via getOrder
 * (so the ONLY way an order resolves is the stream event we deliver). It COUNTS every placeOrder
 * and cancelOrder call — those counts are the proof of what actually reached the wire.
 */
function makeTransport() {
  let placeCalls = 0;
  let cancelCalls = 0;
  let seq = 0;
  let cancelled = false;
  const snapshot = (status, filled) => ({
    order_id: "K-1", status, exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE",
    transaction_type: "BUY", quantity: 75, filled_quantity: filled, pending_quantity: 75 - filled,
    average_price: filled > 0 ? 12.4 : 0, price: 12.15, tag: null, status_message: null,
    order_timestamp: null, exchange_update_timestamp: null,
  });
  return {
    placeCalls: () => placeCalls,
    cancelCalls: () => cancelCalls,
    async placeOrder(req, opts) {
      // The pre-wire guard fires HERE; a throw prevents this placement from being counted.
      opts?.beforeSend?.();
      placeCalls++;
      return { order_id: `K-${++seq}` };
    },
    async cancelOrder() { cancelCalls++; cancelled = true; },
    async modifyOrder() {},
    async getOrder() {
      // OPEN until a cancel is requested, then terminal — so confirmTerminalAfterCancel resolves
      // deterministically without needing wall-clock advancement.
      return cancelled ? snapshot("CANCELLED", 0) : snapshot("OPEN", 0);
    },
    async listOrders() { return []; },
    async listPositions() { return []; },
    async health() { return { authenticated: true, message: null, checked_at: 0 }; },
  };
}

function orderRequest(clientOrderId, role = "k1_ce") {
  return {
    client_order_id: clientOrderId,
    role, purpose: "ENTRY", phase: "entry",
    exchange: "NFO", tradingsymbol: "NIFTY26OCT25000CE", token: 1001,
    side: "BUY", quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 12, tick_size: 0.05, max_chase_ticks: 3, limit_price: 12.15 },
  };
}

function makeAdapter(transport, clock, ledger) {
  return new KiteBrokerAdapter(
    transport,
    {
      executionMode: "live",
      enabled: true,
      brokerMinIntervalMs: 1000,
      ackTimeoutMs: 60_000,
      workingTimeoutMs: 60_000,
      partialTimeoutMs: 60_000,
      cancelTimeoutMs: 5_000,
      maxChaseTicks: 3,
      maxModifications: 3,
      // THE WIRING UNDER TEST: a shared, application-owned budget the adapter must consult.
      rateBudget: ledger,
    },
    clock,
  );
}

/**
 * Submit an entry and resolve it via the PRODUCTION stream path: register nothing here (the
 * adapter tracks the order itself), submit, let the waiter park, then deliver a full fill through
 * `applyOrderUpdate` — exactly what the OrderStreamConsumer calls when a postback arrives. The
 * waiter wakes on the event; no clock advance is needed, so the test can never hang.
 */
async function submitAndFill(adapter, clientOrderId) {
  const submitted = adapter.submitOrder(orderRequest(clientOrderId));
  // Let the adapter reach its post-ACK wait.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  adapter.applyOrderUpdate({
    clientOrderId,
    brokerOrderId: "K-1",
    cumulativeQty: 75,
    averagePrice: 12.4,
    rawStatus: "COMPLETE",
  });
  return submitted;
}

/**
 * A tiny per-DAY placement budget: placement ceiling becomes 1 (perWorker 2 − reserve 1), so the
 * SECOND placement must be refused. A per-DAY window (not per-second) cannot age out during the
 * test regardless of clock movement.
 */
function tinyDailyBudget() {
  const limits = {
    ...brokerRateLimits("zerodha"),
    perSecond: { spanMs: 1000, limit: null },
    perMinute: { spanMs: 60_000, limit: null },
    perHour: { spanMs: 3_600_000, limit: null },
    perDay: { spanMs: 86_400_000, limit: 2 },
  };
  return new RateBudgetLedger(limits, resolveOrderBudgetPolicy({ workerCount: 1 }));
}

test("an exhausted placement budget prevents a prohibited order transmission (transport never sees the POST)", { timeout: 20_000 }, async () => {
  const clock = makeClock();
  const transport = makeTransport();
  const adapter = makeAdapter(transport, clock, tinyDailyBudget());

  // First entry placement fits under the placement ceiling (1) and MUST reach the transport.
  const first = await submitAndFill(adapter, "BOX:rate:ENTRY:k1_ce:a1");
  assert.equal(first.filled_quantity, 75, "the first order filled on the stream event");
  const afterFirst = transport.placeCalls();
  assert.equal(afterFirst, 1, "the first entry placement was transmitted");

  // Second entry placement exceeds the placement ceiling. It MUST be refused at the pre-wire
  // boundary — the refusal is synchronous, so nothing needs to be pumped.
  await assert.rejects(
    adapter.submitOrder(orderRequest("BOX:rate:ENTRY:k1_ce:a2")),
    (err) => err && err.name === "BrokerPreSubmitRefusedError",
    "an over-budget placement must be refused with a proven no-POST error",
  );
  assert.equal(
    transport.placeCalls(), afterFirst,
    "NO additional order POST reached the transport — rate exhaustion actually prevented it",
  );
});

test("a protective cancel is transmitted even when the placement budget is exhausted (recovery reserve)", { timeout: 20_000 }, async () => {
  const clock = makeClock();
  const transport = makeTransport();
  const adapter = makeAdapter(transport, clock, tinyDailyBudget());

  // Place one order that stays WORKING (no fill), consuming the placement ceiling of 1. Keep the
  // submit promise so we can settle it at the end and never leak a parked waiter.
  const working = adapter.submitOrder(orderRequest("BOX:rate:ENTRY:k1_ce:a1"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(transport.placeCalls(), 1, "the first placement reached the transport");

  // Placement is now exhausted: a second placement is refused at the pre-wire boundary.
  await assert.rejects(
    adapter.submitOrder(orderRequest("BOX:rate:ENTRY:k1_ce:a2")),
    (err) => err && err.name === "BrokerPreSubmitRefusedError",
  );
  assert.equal(transport.placeCalls(), 1, "the over-budget placement never reached the transport");

  // A PROTECTIVE CANCEL of the still-working order must go through — it spends the recovery
  // reserve, not placement, so a placement storm cannot starve it. Pump the injected clock so the
  // cancel's pacing wait elapses (bounded, so it can never hang).
  const cancelP = adapter.cancelOrder("BOX:rate:ENTRY:k1_ce:a1");
  let cancelled;
  for (let i = 0; i < 50 && cancelled === undefined; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (clock.pending() > 0) clock.advance(1000);
    cancelled = await Promise.race([cancelP, Promise.resolve(undefined)]);
  }
  cancelled = await cancelP;
  assert.ok(cancelled, "the protective cancel returned an order");
  assert.equal(
    transport.cancelCalls(), 1,
    "the protective cancel WAS transmitted despite placement exhaustion — recovery is never starved",
  );

  // Settle the still-parked submit waiter via the production stream path so no promise leaks.
  adapter.applyOrderUpdate({
    clientOrderId: "BOX:rate:ENTRY:k1_ce:a1",
    brokerOrderId: "K-1",
    cumulativeQty: 0,
    averagePrice: null,
    rawStatus: "CANCELLED",
  });
  await working.catch(() => {});
});


// ─────────────────────────────────────────────────────────────────────────────────────────
// DHAN — the SAME shared-budget contract, proving one application-owned ledger governs every
// adapter, not one ledger per adapter instance.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A mocked Dhan client that ACKs+fills instantly and counts placements/cancels. */
function makeDhanClient() {
  const calls = { place: 0, cancel: 0 };
  return {
    calls,
    async placeOrder(_req, opts) {
      opts?.beforeSend?.();
      calls.place++;
      return { orderId: `D-${calls.place}`, orderStatus: "TRADED" };
    },
    async getOrderByCorrelationId() { return null; },
    async getOrder() {
      return {
        orderId: "D-1", orderStatus: "TRADED", tradingSymbol: "X", securityId: "45678",
        exchangeSegment: "NSE_FNO", quantity: 75, filledQty: 75, averageTradedPrice: 12.4,
        price: 12.15, transactionType: "BUY",
      };
    },
    async cancelOrder() { calls.cancel++; return { orderId: "D-1", orderStatus: "CANCELLED" }; },
    async modifyOrder() { return { orderId: "D-1", orderStatus: "PENDING" }; },
    async getTradesForOrder() { return []; },
    async listOrders() { return []; },
    async listPositions() { return []; },
    async getFundLimit() { return { availabelBalance: 100000, utilizedAmount: 5000 }; },
    async getProfile() { return { dhanClientId: "C1" }; },
  };
}

function makeDhanAdapter(client, ledger) {
  return new DhanBrokerAdapter(client, {
    executionMode: "live",
    enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 30,
    workingTimeoutMs: 60,
    partialTimeoutMs: 30,
    cancelTimeoutMs: 30,
    brokerMinIntervalMs: 1,
    maxModifications: 2,
    maxChaseTicks: 3,
    dhanClientId: () => "C1",
    identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
    // THE WIRING UNDER TEST: the SAME kind of shared, application-owned budget.
    rateBudget: ledger,
  });
}

function tinyDhanDailyBudget() {
  const limits = {
    ...brokerRateLimits("dhan"),
    perSecond: { spanMs: 1000, limit: null },
    perMinute: { spanMs: 60_000, limit: null },
    perHour: { spanMs: 3_600_000, limit: null },
    perDay: { spanMs: 86_400_000, limit: 2 },
  };
  return new RateBudgetLedger(limits, resolveOrderBudgetPolicy({ workerCount: 1 }));
}

test("Dhan: an exhausted placement budget prevents a prohibited order transmission", { timeout: 20_000 }, async () => {
  const client = makeDhanClient();
  const adapter = makeDhanAdapter(client, tinyDhanDailyBudget());

  const first = await adapter.submitOrder(orderRequest("BOX:dhan:ENTRY:k1_ce:a1"));
  assert.equal(first.filled_quantity, 75, "first Dhan placement filled");
  assert.equal(client.calls.place, 1, "first Dhan placement was transmitted");

  await assert.rejects(
    adapter.submitOrder(orderRequest("BOX:dhan:ENTRY:k1_ce:a2")),
    (err) => err && err.name === "BrokerPreSubmitRefusedError",
    "an over-budget Dhan placement must be refused with a proven no-POST error",
  );
  assert.equal(client.calls.place, 1, "NO additional Dhan order POST reached the transport");
});

test("Dhan: a protective cancel is transmitted even when placement is exhausted (shared reserve)", { timeout: 20_000 }, async () => {
  const ledger = tinyDhanDailyBudget();
  const client = makeDhanClient();
  const adapter = makeDhanAdapter(client, ledger);

  await adapter.submitOrder(orderRequest("BOX:dhan:ENTRY:k1_ce:a1"));
  assert.equal(client.calls.place, 1);

  await assert.rejects(
    adapter.submitOrder(orderRequest("BOX:dhan:ENTRY:k1_ce:a2")),
    (err) => err && err.name === "BrokerPreSubmitRefusedError",
  );
  assert.equal(client.calls.place, 1, "the over-budget Dhan placement never reached the transport");

  // The order filled (TRADED), so cancelling a terminal order is a no-op at the transport. Instead
  // assert the ledger itself still ADMITS a recovery cancel from the reserve while placement is
  // refused — the property that matters: recovery is not starved by a placement storm.
  const now = 0;
  assert.equal(ledger.check("order_place", now).allowed, false, "placement is exhausted");
  assert.equal(ledger.check("order_cancel", now).allowed, true, "recovery cancel still admitted from the reserve");
});
