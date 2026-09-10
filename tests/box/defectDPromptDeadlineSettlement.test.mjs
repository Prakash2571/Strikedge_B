/**
 * DEFECT D — PROMPT SETTLEMENT OF AN EXPIRED QUEUED WRITE.
 *
 * `DhanHttp` paces requests by chaining every call onto a serialized tail:
 *
 *     const scheduled = this.tail.then(run, run);   // http.ts ~331
 *
 * and the deadline is only consulted INSIDE `run` (http.ts:188). So a write whose budget lapses
 * while it is QUEUED is not settled when its budget lapses — it is settled when the queue reaches
 * it, which is after the preceding request has finished. Reproduced: a queued write with a 20 ms
 * deadline behind a 300 ms request settled ~137 ms late in the original report, and behind a longer
 * predecessor it settles arbitrarily late. It correctly avoided the POST; it simply did not release
 * its caller.
 *
 * WHY THAT MATTERS. The whole point of a 20 ms budget on a protective/entry write is that the caller
 * gets an answer inside 20 ms and can decide what to do next. A caller blocked for 300 ms holds an
 * entry attempt, a queue slot and a dependent leg's barrier open for fifteen times its budget.
 *
 * THE THREE PROPERTIES UNDER TEST:
 *   D1  the expired queued caller is RELEASED within (a small multiple of) its own budget, not
 *       after the predecessor completes;
 *   D2  the expired queued work NEVER transmits, even though it was already admitted to the queue;
 *   D3  the expiry is reported as a PROVEN NO-POST, distinct from transport ambiguity, so the
 *       caller does not have to reconcile something that provably never left the process.
 *
 * Real timers, real event loop, fake `fetch`. Elapsed time is measured on the wall clock precisely
 * because "did the caller come back in time" is a wall-clock question.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { DhanHttp } from "../../dist/brokers/dhan/http.js";
import { DhanNetworkError } from "../../dist/brokers/dhan/errors.js";
import { Deadline } from "../../dist/brokers/deadline.js";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

/** Install a fetch that answers after `ms`, recording every call. */
function slowFetch(ms) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    await new Promise((resolve) => setTimeout(resolve, ms));
    return new Response(JSON.stringify({ orderId: "DHAN-1", orderStatus: "PENDING" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return calls;
}

function http(overrides = {}) {
  return new DhanHttp({
    accessToken: () => "tok",
    clientId: () => "C1",
    timeoutMs: 5_000,
    minIntervalMs: 0,
    maxReadAttempts: 1,
    ...overrides,
  });
}

const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

test("defect D — a queued write whose deadline expires is released within its own budget", async () => {
  const calls = slowFetch(400);
  const client = http();

  // A long predecessor occupies the serialized pacing tail.
  const first = client.write({ method: "POST", path: "/orders", body: { a: 1 } });

  // The victim: a 20 ms budget, admitted to the queue behind a 400 ms request.
  const budgetMs = 20;
  const startedAt = Date.now();
  const second = client.write({
    method: "POST",
    path: "/orders",
    body: { b: 2 },
    deadline: Deadline.in(budgetMs),
  });

  const outcome = await settle(second);
  const elapsed = Date.now() - startedAt;

  // D1 — PROMPT SETTLEMENT.
  assert.equal(outcome.ok, false, "an expired write cannot succeed");
  assert.ok(
    elapsed < 200,
    `the caller must be released on its OWN ${budgetMs}ms budget, not after the predecessor; ` +
      `it took ${elapsed}ms`,
  );

  // D3 — PROVEN NO-POST, not ambiguity.
  assert.ok(outcome.e instanceof DhanNetworkError, "still a transport error");
  assert.equal(
    outcome.e.transmitted, false,
    "an expiry that never reached the wire must be reported as a PROVEN no-POST, " +
      "so the caller is not sent to reconcile something that never left the process",
  );
  assert.match(outcome.e.message, /queued|expired|abandoned/i);

  // D2 — and it must NEVER transmit later, once the queue reaches it.
  await settle(first);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1, `only the predecessor may have reached the wire; saw ${calls.length}`);
});

test("defect D — a write with budget remaining still transmits normally", async () => {
  const calls = slowFetch(5);
  const client = http();
  const result = await client.write({
    method: "POST",
    path: "/orders",
    body: { a: 1 },
    deadline: Deadline.in(2_000),
  });
  assert.deepEqual(result, { orderId: "DHAN-1", orderStatus: "PENDING" });
  assert.equal(calls.length, 1, "a live budget must not be blocked by the new alarm");
});

test("defect D — an ALREADY expired write is refused before queue admission and never transmits", async () => {
  const calls = slowFetch(5);
  const client = http();
  // Expired before the call is even made.
  const deadline = Deadline.at(-1, 20);
  const outcome = await settle(client.write({ method: "POST", path: "/orders", body: {}, deadline }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.e.transmitted, false, "nothing was sent, and that is provable");
  assert.equal(calls.length, 0, "an expired budget must not be admitted to the queue at all");
});
