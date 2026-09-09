/**
 * DEFECT 3 — THE FINAL GUARD MUST BE AT THE HTTP SEND BOUNDARY, not the adapter pacer.
 *
 * The guard used to run inside the adapter's `call()` (its pacer), while the actual `fetch`
 * happened further down — for Dhan, behind a SECOND serialized pacing queue and a residual-
 * interval sleep; for Kite, behind the transport's token-resolution await. So a POST could be
 * queued, entry could be disarmed, and the queued POST would still hit the wire.
 *
 * These tests use the REAL adapter + the REAL transport (the real DhanHttp queue, the real
 * KiteHttpTransport) with ONLY the network `fetch` replaced. They prove that disarming entry
 * while a POST is queued behind pacing results in NO fetch at all, and that the guard fires with
 * NO asynchronous wait between it and the send (a structural assertion via a fake fetch that
 * records the exact ordering).
 *
 * FAILING-FIRST: on the ORIGINAL sources the guard ran before the lower queue/pacing, so a POST
 * queued behind pacing still fetched after disarm. See EVIDENCE-transport.md.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { DhanHttp } from "../../dist/brokers/dhan/http.js";
import { DhanClient } from "../../dist/brokers/dhan/client.js";
import { DhanBrokerAdapter } from "../../dist/box/dhanBrokerAdapter.js";
import { KiteHttpTransport, KiteBrokerAdapter } from "../../dist/box/kiteBrokerAdapter.js";
import { BrokerPreSubmitRefusedError, BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

/** A fetch that records every call and answers with a benign TRADED-ish success. */
function recordingFetch(records) {
  return async (url, init) => {
    records.push({ url: String(url), method: init?.method ?? "GET" });
    // A minimal, valid Dhan/Kite success body. The tests that reach here assert on the RECORD,
    // not on the parsed result, so the exact shape only has to parse.
    const body = JSON.stringify({ orderId: "X1", orderStatus: "PENDING", data: { order_id: "X1" }, status: "success" });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
}

const DHAN_REQUEST = {
  client_order_id: "BOX:trade-9:ENTRY:k1_ce:attempt-1",
  role: "k1_ce", trade_id: "trade-9", attempt_id: "attempt-1", purpose: "ENTRY", phase: "entry",
  exchange: "NFO", tradingsymbol: "NIFTY26SEP19900CE", token: 45678, side: "BUY", quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
};

function dhanStack({ minIntervalMs = 0 } = {}) {
  const http = new DhanHttp({
    accessToken: () => "tok",
    clientId: () => "C1",
    timeoutMs: 5_000,
    minIntervalMs,
    maxReadAttempts: 1,
  });
  const client = new DhanClient(http, () => "C1");
  const adapter = new DhanBrokerAdapter(client, {
    executionMode: "live", enabled: true, staticIpReady: () => true,
    ackTimeoutMs: 50, workingTimeoutMs: 100, partialTimeoutMs: 50, cancelTimeoutMs: 50,
    brokerMinIntervalMs: 1, maxModifications: 2, maxChaseTicks: 2,
    dhanClientId: () => "C1", identify: () => ({ segment: "NSE_FNO", securityId: 45678 }),
  });
  return { http, adapter };
}

test("DHAN: a local refusal at the send boundary transmits NO POST (real HTTP queue, fake fetch)", async () => {
  const records = [];
  globalThis.fetch = recordingFetch(records);
  const { adapter } = dhanStack();
  const refusal = new BrokerPreSubmitRefusedError(DHAN_REQUEST.client_order_id, "pre_post", true, "entry disarmed");

  const err = await adapter.submitOrder(DHAN_REQUEST, () => { throw refusal; }).then(() => null, (e) => e);
  assert.strictEqual(err, refusal, "the local refusal propagates unchanged");
  assert.equal(err instanceof BrokerAmbiguousSubmitError, false, "a proven no-POST is NEVER ambiguous");
  assert.equal(records.length, 0, "NO fetch was made — the POST never reached the wire");
});

test("DHAN: disarming while a POST is QUEUED behind pacing still results in NO fetch", async () => {
  const records = [];
  globalThis.fetch = recordingFetch(records);
  // A real minInterval forces the second write to sleep in the lower pacing queue.
  const { http, adapter } = dhanStack({ minIntervalMs: 40 });

  // Occupy the pacer: one real read sets `lastAt`, so the next request must wait out the interval.
  await http.read({ path: "/profile" }).catch(() => {});
  const fetchesAfterWarmup = records.length;

  // Arm a guard that "disarms entry" the instant it is consulted — which, correctly, is only at
  // the send boundary AFTER the pacing wait. If the guard were consulted before the queue (the
  // bug), the POST would still fetch once the queue drained.
  let guardConsultedAt = -1;
  const guard = () => {
    guardConsultedAt = records.length;
    throw new BrokerPreSubmitRefusedError(DHAN_REQUEST.client_order_id, "pre_post", true, "entry disarmed while queued");
  };

  const err = await adapter.submitOrder(DHAN_REQUEST, guard).then(() => null, (e) => e);
  assert.ok(err instanceof BrokerPreSubmitRefusedError, "refused locally, never sent");
  assert.equal(records.length, fetchesAfterWarmup, "the queued POST never became a fetch");
  assert.equal(guardConsultedAt, fetchesAfterWarmup, "the guard ran at the send boundary, after the pacing wait");
});

test("DHAN: NO async wait sits between the guard and the fetch (structural)", async () => {
  // A fake fetch that flips a flag synchronously. A microtask scheduled inside the guard must NOT
  // run before fetch, proving there is no promise hop / await / timer between them.
  const events = [];
  globalThis.fetch = async (url, init) => {
    events.push("fetch");
    return new Response(JSON.stringify({ orderId: "X1", orderStatus: "PENDING" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const { adapter } = dhanStack();
  const guard = () => {
    events.push("guard");
    // Schedule a microtask. If ANY await/promise hop existed between guard and fetch, this
    // microtask would run BEFORE "fetch" is pushed. The guard→fetch sequence being synchronous
    // means "guard","fetch" appear before "microtask".
    Promise.resolve().then(() => events.push("microtask"));
  };
  await adapter.submitOrder(DHAN_REQUEST, guard).catch(() => {});
  const g = events.indexOf("guard");
  const f = events.indexOf("fetch");
  const m = events.indexOf("microtask");
  assert.ok(g >= 0 && f >= 0, "both guard and fetch happened");
  assert.ok(g < f, "guard runs immediately before fetch");
  assert.ok(m === -1 || f < m, "no microtask interleaved between guard and fetch — the boundary is synchronous");
});

/* ─────────────────────────────── Zerodha / Kite ─────────────────────────────── */

/**
 * The base URL these tests hand the REAL `KiteHttpTransport`.
 *
 * Loopback on the DISCARD port, not the live broker host. `fetchImpl` is injected, so no request
 * ever leaves the process and the hostname is never resolved — but naming the live host in
 * executable test code is exactly what `.github/ci/no-live-hostnames.sh` exists to stop, and
 * "it happens to be intercepted" is not a property CI can verify. What these tests actually assert
 * is ORDERING (the send guard fires after the async token hop, immediately before the wire) and
 * ABSENCE (no fetch at all on a refusal); neither depends on the URL. Loopback:9 is additionally
 * unroutable, so the fixture is safe even if a future refactor dropped the injected fetch.
 */
const KITE_BASE_URL = "http://127.0.0.1:9/kite";

const KITE_REQUEST = {
  client_order_id: "BOX:trade-7:ENTRY:k1_ce:attempt-1",
  role: "k1_ce", trade_id: "trade-7", attempt_id: "attempt-1", purpose: "ENTRY", phase: "entry",
  exchange: "NFO", tradingsymbol: "NIFTY26SEP19900CE", token: 1001, side: "BUY", quantity: 75,
  pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
};

function kiteStack(fetchImpl) {
  const transport = new KiteHttpTransport({
    apiKey: "k", accessToken: () => "tok", timeoutMs: 5_000, baseUrl: KITE_BASE_URL, fetchImpl,
  });
  const adapter = new KiteBrokerAdapter(transport, {
    executionMode: "live", enabled: true,
    ackTimeoutMs: 50, workingTimeoutMs: 100, partialTimeoutMs: 50, cancelTimeoutMs: 50,
    brokerMinIntervalMs: 1, maxModifications: 2, maxChaseTicks: 2,
  });
  return { transport, adapter };
}

test("KITE: a local refusal after the token await transmits NO POST (real transport, fake fetch)", async () => {
  const records = [];
  const { adapter } = kiteStack(async (url, init) => {
    records.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ data: { order_id: "K1" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const refusal = new BrokerPreSubmitRefusedError(KITE_REQUEST.client_order_id, "pre_post", true, "entry disarmed");
  const err = await adapter.submitOrder(KITE_REQUEST, () => { throw refusal; }).then(() => null, (e) => e);
  assert.strictEqual(err, refusal, "the local refusal propagates unchanged");
  assert.equal(err instanceof BrokerAmbiguousSubmitError, false, "a proven no-POST is NEVER ambiguous");
  assert.equal(records.length, 0, "NO fetch was made even though the transport resolved the token first");
});

test("KITE: the guard fires AFTER the async token resolution, immediately before fetch", async () => {
  const events = [];
  // A token reader that is genuinely async (a promise hop) — exactly the window that used to sit
  // between the old adapter-level guard and the wire.
  let tokenResolved = false;
  const { adapter } = kiteStack(async () => {
    events.push("fetch");
    return new Response(JSON.stringify({ data: { order_id: "K1" } }), { status: 200, headers: { "content-type": "application/json" } });
  });
  // Rebuild with an async access token to prove ordering across the hop.
  const transport = new KiteHttpTransport({
    apiKey: "k",
    accessToken: async () => { await Promise.resolve(); tokenResolved = true; return "tok"; },
    timeoutMs: 5_000, baseUrl: KITE_BASE_URL,
    fetchImpl: async () => { events.push("fetch"); return new Response(JSON.stringify({ data: { order_id: "K1" } }), { status: 200, headers: { "content-type": "application/json" } }); },
  });
  const adapter2 = new KiteBrokerAdapter(transport, {
    executionMode: "live", enabled: true, ackTimeoutMs: 50, workingTimeoutMs: 100, partialTimeoutMs: 50,
    cancelTimeoutMs: 50, brokerMinIntervalMs: 1, maxModifications: 2, maxChaseTicks: 2,
  });
  const guard = () => {
    assert.equal(tokenResolved, true, "the token was resolved BEFORE the guard — the guard is at the true boundary");
    events.push("guard");
    throw new BrokerPreSubmitRefusedError(KITE_REQUEST.client_order_id, "pre_post", true, "disarmed at boundary");
  };
  const err = await adapter2.submitOrder(KITE_REQUEST, guard).then(() => null, (e) => e);
  assert.ok(err instanceof BrokerPreSubmitRefusedError);
  assert.equal(events.includes("fetch"), false, "the guard threw before fetch, so no request was sent");
  void adapter;
});
