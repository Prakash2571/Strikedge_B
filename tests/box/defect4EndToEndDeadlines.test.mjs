/**
 * DEFECT 4 — END-TO-END DEADLINES in the Dhan HTTP transport.
 *
 * The original transport:
 *   - armed the AbortController AFTER the pacing sleep and cleared it the instant headers
 *     arrived, leaving `await res.text()` completely UNBOUNDED (a stalled body hung forever);
 *   - measured elapsed time with wall-clock `Date.now()` (a clock step could bypass a deadline);
 *   - restarted the FULL timeout budget at every read retry, so N retries could take N×timeout.
 *
 * These tests inject a controllable monotonic clock and a fake fetch to prove:
 *   - a stalled BODY aborts under the request deadline (not just a stalled header);
 *   - queue waiting is bounded — a write that expires while queued NEVER transmits;
 *   - read retries share ONE absolute budget rather than restarting it per attempt;
 *   - the deadline is measured on the injected MONOTONIC clock.
 *
 * FAILING-FIRST: on the ORIGINAL http.ts the stalled-body test hangs (unbounded) and the shared-
 * budget test lets retries overrun. See EVIDENCE-transport.md.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { DhanHttp } from "../../dist/brokers/dhan/http.js";
import { DhanNetworkError, DhanError } from "../../dist/brokers/dhan/errors.js";
import { Deadline } from "../../dist/brokers/deadline.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

/** A monotonic clock the test advances by hand. */
function virtualClock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A Response whose body read never settles until aborted — models a stalled body. */
function stalledBodyResponse(signal) {
  const stalledBody = new ReadableStream({
    start(controller) {
      // Never enqueue/close. Abort rejects the pending read via the signal.
      if (signal) signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(stalledBody, { status: 200, headers: { "content-type": "application/json" } });
}

function http({ minIntervalMs = 0, maxReadAttempts = 1, timeoutMs = 100, clock } = {}) {
  return new DhanHttp({
    accessToken: () => "tok",
    clientId: () => "C1",
    timeoutMs,
    minIntervalMs,
    maxReadAttempts,
    ...(clock ? { monotonic: clock.now } : {}),
  });
}

test("a stalled RESPONSE BODY is aborted under the request deadline (not left unbounded)", async () => {
  // headers arrive immediately; the body never settles. The old code cleared the timer at
  // headers and awaited res.text() forever. Now the same deadline covers the body.
  globalThis.fetch = async (_url, init) => stalledBodyResponse(init?.signal);
  const h = http({ timeoutMs: 60 });
  const err = await h.read({ path: "/orders" }).then(() => null, (e) => e);
  assert.ok(err instanceof DhanNetworkError, `expected a bounded network error, got ${err}`);
  assert.match(err.message, /body timed out|timed out/, "the failure names a body/deadline timeout");
});

test("a WRITE that expires while QUEUED behind pacing NEVER transmits", async () => {
  const clock = virtualClock();
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return new Response(JSON.stringify({ orderId: "X" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  // A large pacing interval and a first request to set `lastAt`. The second write's deadline is
  // shorter than the residual pacing wait, so it must be abandoned BEFORE the wire.
  const h = http({ minIntervalMs: 10_000, timeoutMs: 50, clock });
  await h.read({ path: "/profile" }).catch(() => {});
  const fetchesAfterFirst = fetches;

  // Advance the clock so the SECOND request's own deadline (50ms) is already blown by the time it
  // would leave the pacing queue (10s away). It must never fetch.
  const writePromise = h.write({ method: "POST", path: "/orders", body: { a: 1 } });
  clock.advance(60); // past the write's 50ms budget, still far short of the 10s pacing gap
  const err = await writePromise.then(() => null, (e) => e);
  assert.ok(err instanceof DhanNetworkError, "the expired write failed rather than transmitting");
  assert.match(err.message, /abandoned before send|queued|pacing/, "the message says it never reached the wire");
  assert.equal(fetches, fetchesAfterFirst, "NO additional fetch — the expired queued write never transmitted");
});

test("read retries share ONE absolute budget rather than restarting per attempt", async () => {
  const clock = virtualClock();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    // Each attempt consumes 60ms of the SHARED budget on the injected clock.
    clock.advance(60);
    return new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  };
  const h = http({ maxReadAttempts: 3, timeoutMs: 1_000, clock });
  // One ABSOLUTE 100ms deadline shared across all retries, anchored to the injected clock. If the
  // budget restarted per attempt (the bug) all 3 attempts would run; with one shared budget the
  // second attempt pushes the injected clock past 100ms and the third is refused before sending.
  const deadline = Deadline.at(clock.now() + 100, 100, clock.now);
  const err = await h.read({ path: "/orders", deadline }).then(() => null, (e) => e);
  assert.ok(err instanceof DhanError, "the read failed");
  assert.ok(attempts >= 1, "at least the first attempt ran");
  assert.ok(attempts < 3, `retries stopped once the shared budget expired (attempts=${attempts}), not a fresh budget each time`);
});

test("elapsed time is measured on the INJECTED monotonic clock, not Date.now()", async () => {
  // If the transport used Date.now(), advancing the injected clock would have no effect and the
  // pacing wait would be computed against wall time. We prove the injected clock governs pacing by
  // showing a huge injected-clock jump satisfies the interval with no real sleep.
  const clock = virtualClock();
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
  const h = http({ minIntervalMs: 5_000, timeoutMs: 10_000, clock });
  await h.read({ path: "/a" });                 // sets lastAt on the injected clock
  clock.advance(6_000);                          // exceed the 5s interval on the INJECTED clock only
  const started = Date.now();
  await h.read({ path: "/b" });                  // should NOT really sleep 5s — the injected clock already elapsed
  const realElapsed = Date.now() - started;
  assert.equal(fetches, 2, "both reads went through");
  assert.ok(realElapsed < 1_000, `no real 5s sleep occurred (real elapsed ${realElapsed}ms) — pacing used the injected clock`);
});
