/**
 * BOUNDED QUEUE — the backpressure primitive (GAP 2).
 *
 * Before this there was NO bounded-queue primitive in production: a WebSocket callback processed
 * inline, so a slow stage (SSE fan-out, the Atlas/Mongo projection, expensive analytics) blocked
 * the event loop and therefore order-state processing itself. This suite pins the guarantees the
 * brief requires of the primitive:
 *
 *   - it exposes queue DEPTH, OLDEST-QUEUED-EVENT AGE, and an OVERLOAD signal;
 *   - stages are SEPARATED: a slow drain on one stage cannot block enqueue on another, and cannot
 *     block or drop another stage's processing (the load-bearing safety property);
 *   - MARKET SNAPSHOTS may be COALESCED latest-per-instrument (Kite/Dhan quote packets are full
 *     snapshots per book) — the queue keeps only the newest per key under pressure;
 *   - ORDER EVENTS are NEVER silently dropped: their queue does not coalesce and does not evict;
 *     under overload it records the degraded condition and signals overload, but every enqueued
 *     order event is still delivered;
 *   - overflow of a droppable (coalescing) stage records the degraded condition and raises the
 *     overload signal (so the caller can block new entry / reconcile) rather than failing silent;
 *   - the queue is deterministic and bounded: it never leaves a dangling timer or unresolved
 *     promise, so `node --test` exits.
 *
 * Fully deterministic: an injected clock for age, and manual drain (no real timers).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoundedQueue, StagePipeline } from "../../dist/box/boundedQueue.js";

function fixedClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("exposes depth, oldest-queued-age and an overload signal", () => {
  const clock = fixedClock();
  const q = new BoundedQueue({ name: "md", capacity: 4, overflow: "coalesce", now: clock.now });
  assert.equal(q.depth(), 0);
  assert.equal(q.oldestAgeMs(), null, "no items ⇒ no age");
  assert.equal(q.isOverloaded(), false);

  q.enqueue(1, "a");
  clock.advance(50);
  q.enqueue(2, "b");
  assert.equal(q.depth(), 2);
  assert.equal(q.oldestAgeMs(), 50, "age is measured from the OLDEST queued item");
  assert.equal(q.isOverloaded(), false);
});

test("coalescing keeps only the newest snapshot per key and never grows unbounded", () => {
  const clock = fixedClock();
  const q = new BoundedQueue({ name: "md", capacity: 3, overflow: "coalesce", now: clock.now });
  // Same instrument key 'X' updated many times: a full-snapshot feed, safe to coalesce.
  for (let i = 0; i < 100; i++) q.enqueue({ token: "X", v: i }, "X");
  assert.equal(q.depth(), 1, "latest-per-instrument coalescing keeps one entry per key");
  const drained = q.drainAll();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].v, 99, "the NEWEST snapshot survives, not a stale one");
});

test("coalescing overflow across DISTINCT keys records degraded + raises overload, drops the oldest snapshot", () => {
  const clock = fixedClock();
  let overloadEvents = 0;
  const q = new BoundedQueue({
    name: "md",
    capacity: 2,
    overflow: "coalesce",
    now: clock.now,
    onOverload: () => { overloadEvents++; },
  });
  q.enqueue({ v: 1 }, "A");
  q.enqueue({ v: 2 }, "B");
  assert.equal(q.isOverloaded(), false);
  // A third DISTINCT key exceeds capacity. A full-snapshot feed can drop the OLDEST book (it will
  // be re-published), but it must NOT do so silently: overload is raised and degraded recorded.
  q.enqueue({ v: 3 }, "C");
  assert.equal(q.depth(), 2, "capacity is respected");
  assert.equal(q.isOverloaded(), true, "a dropped snapshot must raise the overload signal");
  assert.ok(overloadEvents >= 1, "the degraded condition is recorded, never silent");
  assert.ok(q.diagnostics().dropped >= 1, "the drop is counted");
});

test("ORDER-EVENT queue NEVER drops and NEVER coalesces, even far past capacity", () => {
  const clock = fixedClock();
  let overloadEvents = 0;
  const q = new BoundedQueue({
    name: "orders",
    capacity: 3,
    overflow: "never-drop",
    now: clock.now,
    onOverload: () => { overloadEvents++; },
  });
  for (let i = 0; i < 50; i++) q.enqueue({ orderId: `o${i}`, seq: i }, `o${i}`);
  assert.equal(q.depth(), 50, "an order queue holds EVERY event; it must never drop one");
  assert.equal(q.isOverloaded(), true, "past capacity it signals overload (to block new entry)");
  assert.ok(overloadEvents >= 1, "the overload condition is recorded");
  assert.equal(q.diagnostics().dropped, 0, "ZERO order events dropped — the whole point");
  const all = q.drainAll();
  assert.equal(all.length, 50);
  assert.deepEqual(all.map((x) => x.seq), Array.from({ length: 50 }, (_, i) => i), "FIFO order preserved");
});

test("a slow stage cannot block or drop another stage's processing (STAGE SEPARATION)", async () => {
  const clock = fixedClock();
  const pipeline = new StagePipeline({ now: clock.now });

  const orderProcessed = [];
  // A DELIBERATELY slow SSE/analytics stage: each drain awaits a promise the test controls.
  let releaseSlow;
  const slowGate = () => new Promise((res) => { releaseSlow = res; });
  const sseProcessed = [];

  pipeline.addStage({
    name: "orders",
    capacity: 100,
    overflow: "never-drop",
    handler: async (evt) => { orderProcessed.push(evt); },
  });
  pipeline.addStage({
    name: "sse",
    capacity: 100,
    overflow: "coalesce",
    handler: async (evt) => { await slowGate(); sseProcessed.push(evt); },
  });

  // Enqueue to BOTH stages. The slow SSE stage will park on the gate.
  pipeline.enqueue("sse", { u: 1 }, "u1");
  pipeline.enqueue("orders", { orderId: "A", seq: 0 }, "A");
  pipeline.enqueue("orders", { orderId: "B", seq: 1 }, "B");

  // Start draining the SSE stage but DO NOT await it — its handler parks on the gate, modelling a
  // slow frontend/analytics consumer that is mid-flight and blocked.
  const ssePump = pipeline.pumpUntilIdle({ stages: ["sse"] });

  // Orders must fully process even though the SSE stage is blocked on its gate.
  await pipeline.pumpUntilIdle({ stages: ["orders"] });
  assert.deepEqual(orderProcessed.map((x) => x.orderId), ["A", "B"],
    "order-state processing completes while the SSE stage is blocked");
  assert.equal(sseProcessed.length, 0, "the SSE stage is indeed still blocked");

  // Now release the slow stage and confirm it drains without having dropped orders.
  assert.equal(typeof releaseSlow, "function", "the slow SSE handler is mid-flight, parked on the gate");
  releaseSlow();
  await ssePump;
  assert.equal(sseProcessed.length, 1);
  assert.equal(orderProcessed.length, 2, "orders were never lost or reprocessed");

  // No dangling work.
  assert.equal(pipeline.totalDepth(), 0);
});

test("an order stage under overload signals the pipeline overloaded WITHOUT dropping order events", async () => {
  const clock = fixedClock();
  const pipeline = new StagePipeline({ now: clock.now });
  const processed = [];
  pipeline.addStage({
    name: "orders",
    capacity: 2,
    overflow: "never-drop",
    handler: async (evt) => { processed.push(evt); },
  });
  // Flood the order stage past capacity WITHOUT pumping — it must retain everything and flag overload.
  for (let i = 0; i < 10; i++) pipeline.enqueue("orders", { orderId: `o${i}`, seq: i }, `o${i}`);
  assert.equal(pipeline.isOverloaded(), true, "overload is visible to the caller to block new entry");
  assert.equal(pipeline.stage("orders").diagnostics().dropped, 0);

  await pipeline.pumpUntilIdle({ stages: ["orders"] });
  assert.equal(processed.length, 10, "every order event was delivered despite the overload");
  assert.equal(pipeline.isOverloaded(), false, "overload clears once the backlog drains");
});

test("WebSocket callbacks stay lightweight: enqueue is synchronous and does not run the handler inline", () => {
  const clock = fixedClock();
  const pipeline = new StagePipeline({ now: clock.now });
  let handlerRuns = 0;
  pipeline.addStage({
    name: "md",
    capacity: 10,
    overflow: "coalesce",
    handler: async () => { handlerRuns++; },
  });
  // The callback seam: enqueue only. The handler must NOT run synchronously inside enqueue.
  pipeline.enqueue("md", { token: 1 }, "1");
  pipeline.enqueue("md", { token: 2 }, "2");
  assert.equal(handlerRuns, 0, "enqueue must not process inline — that is what blocks the socket");
  assert.equal(pipeline.stage("md").depth(), 2);
});

test("draining is bounded and deterministic: pumpUntilIdle terminates and leaves nothing pending", async () => {
  const clock = fixedClock();
  const pipeline = new StagePipeline({ now: clock.now });
  const seen = [];
  pipeline.addStage({
    name: "work",
    capacity: 1000,
    overflow: "never-drop",
    handler: async (e) => { seen.push(e); },
  });
  for (let i = 0; i < 200; i++) pipeline.enqueue("work", i, String(i));
  await pipeline.pumpUntilIdle();
  assert.equal(seen.length, 200);
  assert.equal(pipeline.totalDepth(), 0);
  // Idempotent: pumping an empty pipeline returns immediately.
  await pipeline.pumpUntilIdle();
  assert.equal(seen.length, 200);
});
