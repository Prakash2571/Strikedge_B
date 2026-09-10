/**
 * DHAN REAL-TIMED HARNESS — exercises the REAL DhanBrokerAdapter on WALL TIME.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SEPARATE HARNESS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The composed-path benchmark (bench/composedLatency.mjs) runs on a discrete-event VIRTUAL clock,
 * which the KiteBrokerAdapter supports (it accepts an injected `{now,wait}`). The DhanBrokerAdapter
 * does NOT: its transport pacer uses `Date.now()`/`sleep()` and its poll/protective-cancel loops
 * sleep on real timers (only DURATION deadlines take an injected monotonic clock). So the only
 * honest way to run the REAL Dhan `submitOrder → waitForResolution → getOrder` code is on REAL
 * time.
 *
 * To keep it fast the assumed delays here are DELIBERATELY SMALL (single-digit ms). The point of
 * this harness is to prove the REAL Dhan code path executes end-to-end (place → ACK → REST-poll
 * confirmation → terminal) and to measure OUR overhead on it — NOT to produce latency numbers
 * comparable to the Kite cells or to any live broker. Its ms figures are therefore reported
 * separately and must never be quoted as Dhan latency.
 *
 * Run:  node bench/compositeRealTimed.mjs [--iterations=N]
 */

import { DhanBrokerAdapter } from "../dist/box/dhanBrokerAdapter.js";
import { dhanCorrelationId } from "../dist/brokers/dhan/correlation.js";

const TRADE = "bench-dhan";

function legRequest(role, side, attempt) {
  const clientOrderId = `BOX:${TRADE}:ENTRY:${role}:${attempt}`;
  return {
    client_order_id: clientOrderId,
    role, trade_id: TRADE, attempt_id: attempt,
    purpose: "ENTRY", phase: "entry",
    exchange: "NFO", tradingsymbol: `NIFTY-${role}`, token: 45678,
    side, quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: side === "BUY" ? 100.1 : 99.9 },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake Dhan client whose order, after a small REAL delay, reports TRADED via getOrder. The
 * adapter's own poll loop calls getOrder; we do not push — REST confirmation is the path here,
 * which is exactly the "REST fallback" posture proving the real waiter confirms via getOrder.
 */
function makeDhanClient({ postMs, fillMs }) {
  const calls = { place: 0, get: 0, byCorrelation: 0, cancel: 0 };
  const placedAt = new Map(); // orderId -> wall time placed
  let nextId = 1;
  return {
    calls,
    placeOrder: async (_req, opts) => {
      opts?.beforeSend?.();
      calls.place++;
      await sleep(postMs);
      const orderId = `DHAN-${nextId++}`;
      placedAt.set(orderId, Date.now());
      return { orderId, orderStatus: "TRANSIT" };
    },
    getOrder: async (orderId) => {
      calls.get++;
      const at = placedAt.get(orderId) ?? Date.now();
      const done = Date.now() - at >= fillMs;
      return {
        orderId, orderStatus: done ? "TRADED" : "PENDING",
        tradingSymbol: "NIFTY", securityId: "45678", exchangeSegment: "NSE_FNO",
        quantity: 75, filledQty: done ? 75 : 0,
        averageTradedPrice: done ? 100 : 0, price: 100, transactionType: "BUY",
      };
    },
    getOrderByCorrelationId: async () => { calls.byCorrelation++; return null; },
    cancelOrder: async () => { calls.cancel++; return { orderId: "1", orderStatus: "CANCELLED" }; },
    modifyOrder: async () => ({ orderId: "1", orderStatus: "PENDING" }),
    getTradesForOrder: async () => [],
    listOrders: async () => [],
    listPositions: async () => [],
    getFundLimit: async () => ({ availabelBalance: 1e9, utilizedAmount: 0 }),
    getProfile: async () => ({ dhanClientId: "C1" }),
  };
}

function makeDhanAdapter(client) {
  return new DhanBrokerAdapter(client, {
    executionMode: "live", enabled: true,
    staticIpReady: () => true,
    ackTimeoutMs: 2000, workingTimeoutMs: 4000, partialTimeoutMs: 2000, cancelTimeoutMs: 1000,
    brokerMinIntervalMs: 8, // small so pacing arithmetic runs but the harness stays fast
    maxModifications: 2, maxChaseTicks: 2,
    dhanClientId: () => "C1",
    identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
  });
}

async function runOne({ postMs, fillMs }) {
  const client = makeDhanClient({ postMs, fillMs });
  const adapter = makeDhanAdapter(client);
  const legs = [["k1_ce", "BUY", 0], ["k2_pe", "BUY", 0], ["k2_ce", "SELL", 1], ["k1_pe", "SELL", 1]];
  const t0 = Date.now();
  let firstSend = null, firstFill = null;
  // Hedge-first: wave 0 concurrently, await both, then wave 1.
  const wave = async (w) => {
    const batch = legs.filter((l) => l[2] === w);
    return Promise.all(batch.map(async ([role, side]) => {
      const req = legRequest(role, side, "a1");
      const before = Date.now();
      if (firstSend === null) firstSend = before - t0;
      const order = await adapter.submitOrder(req);
      if (order.filled_quantity > 0 && firstFill === null) firstFill = Date.now() - t0;
      return order;
    }));
  };
  const w0 = await wave(0);
  const hedgesOk = w0.every((o) => o.state === "COMPLETE");
  const w1 = hedgesOk ? await wave(1) : [];
  const all = [...w0, ...w1];
  const completed = all.filter((o) => o.state === "COMPLETE").length;
  return {
    four_leg_completion_ms: Date.now() - t0,
    first_send_ms: firstSend,
    first_fill_ms: firstFill,
    completed, four_leg_completed: completed === 4,
    get_calls: client.calls.get, place_calls: client.calls.place,
  };
}

function pct(vals, p) { const s = [...vals].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; }

async function main() {
  const itArg = process.argv.find((a) => a.startsWith("--iterations="));
  const iterations = itArg ? Math.max(1, parseInt(itArg.split("=")[1], 10)) : 20;
  // SMALL, real wall-clock delays — assumptions, and deliberately not comparable to the Kite cells.
  const assume = { postMs: 3, fillMs: 12 };
  const runs = [];
  for (let i = 0; i < iterations; i++) runs.push(await runOne(assume));
  const comp = runs.map((r) => r.four_leg_completion_ms);
  console.log("─────────────────────────────────────────────────────────────────────────────");
  console.log("DHAN REAL-TIMED SMOKE (REAL DhanBrokerAdapter on WALL TIME — SMALL assumed delays)");
  console.log("Purpose: prove the REAL Dhan place→ACK→REST-poll→terminal path executes; NOT a latency");
  console.log("comparison. Assumed delays are tiny wall-clock ms and are NOT live Dhan measurements.");
  console.log("─────────────────────────────────────────────────────────────────────────────");
  console.log(`assumed: postMs=${assume.postMs} fillMs=${assume.fillMs}  (wall-clock, chosen small for speed)`);
  console.log(`iterations: ${iterations}`);
  console.log(`four-leg completion wall-ms  p50=${pct(comp, 0.5)}  p95=${pct(comp, 0.95)}  max=${Math.max(...comp)}`);
  console.log(`four-leg completions: ${runs.filter((r) => r.four_leg_completed).length}/${iterations}`);
  console.log(`REST getOrder confirmations used (proves the real waiter polls): total across a run = ${runs[0].get_calls} per entry set, place calls = ${runs[0].place_calls}`);
  console.log("These numbers describe OUR code's overhead on the real Dhan waiter, on small assumed");
  console.log("wall delays — they are NOT Dhan broker latency and must not be quoted as such.");
}

main().catch((e) => { console.error(e); process.exit(1); });
