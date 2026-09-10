/**
 * SCHEDULER-CORRECTNESS PROOF for the composed-path benchmark.
 *
 * The old benchmark's virtual clock summed concurrent waits (t += ms), so two 100 ms waits that
 * OVERLAP reported completion at 200 ms. These tests pin the replacement discrete-event scheduler
 * to the correct behaviour: concurrent waits overlap (t = 100), sequential waits add (t = 200),
 * and staggered waits resolve at their own absolute deadlines.
 *
 * This file lives under the `tests/box/bench` prefix owned by the benchmark track and is picked
 * up by the `unit` suite glob (`tests/box/*.test.mjs`).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createScheduler } from "../../bench/scheduler.mjs";

test("two concurrent 100ms waits complete at t=100, NOT t=200 (the old clock's bug)", async () => {
  const clock = createScheduler(0);
  const done = [];
  // Start both waits WITHOUT awaiting — they are concurrent, like two legs in flight.
  const a = clock.wait(100).then(() => done.push(["a", clock.now()]));
  const b = clock.wait(100).then(() => done.push(["b", clock.now()]));
  await clock.drain();
  await Promise.all([a, b]);

  assert.equal(clock.now(), 100, "the clock advanced to the single shared deadline, not the sum");
  assert.deepEqual(
    done.sort(),
    [["a", 100], ["b", 100]],
    "both concurrent waits resolved at t=100",
  );
});

test("two sequential 100ms waits DO add up to t=200", async () => {
  const clock = createScheduler(0);
  const marks = [];
  const run = (async () => {
    await clock.wait(100);
    marks.push(["first", clock.now()]);
    await clock.wait(100);
    marks.push(["second", clock.now()]);
  })();
  await clock.drain();
  await run;

  assert.deepEqual(marks, [["first", 100], ["second", 200]], "awaited-in-series waits sum");
  assert.equal(clock.now(), 200);
});

test("staggered concurrent waits resolve at their own absolute deadlines", async () => {
  const clock = createScheduler(0);
  const at = {};
  const p1 = clock.wait(40).then(() => { at.short = clock.now(); });
  const p2 = clock.wait(160).then(() => { at.long = clock.now(); });
  const p3 = clock.wait(70).then(() => { at.mid = clock.now(); });
  await clock.drain();
  await Promise.all([p1, p2, p3]);

  assert.equal(at.short, 40);
  assert.equal(at.mid, 70);
  assert.equal(at.long, 160, "the longest concurrent wait ends at 160, not 40+70+160");
  assert.equal(clock.now(), 160);
});

test("drain fires timers registered by woken code at the same instant (microtask fence)", async () => {
  const clock = createScheduler(0);
  const seen = [];
  const chained = (async () => {
    await clock.wait(50);
    seen.push(["outer", clock.now()]);
    // A follow-up wait registered AFTER waking — must still be honoured.
    await clock.wait(50);
    seen.push(["inner", clock.now()]);
  })();
  await clock.drain();
  await chained;
  assert.deepEqual(seen, [["outer", 50], ["inner", 100]]);
});

test("a zero-length wait yields without advancing the clock", async () => {
  const clock = createScheduler(0);
  let resolved = false;
  const p = clock.wait(0).then(() => { resolved = true; });
  await clock.drain();
  await p;
  assert.equal(resolved, true);
  assert.equal(clock.now(), 0);
});

test("non-finite delays fail loudly rather than poisoning the clock", async () => {
  const clock = createScheduler(0);
  assert.throws(() => clock.wait(NaN), /non-finite/);
  assert.throws(() => clock.wait(Infinity), /non-finite/);
});
