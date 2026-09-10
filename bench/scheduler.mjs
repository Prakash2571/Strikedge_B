/**
 * DISCRETE-EVENT SCHEDULER — a correct virtual clock for the composed-path benchmark.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS REPLACES THE OLD `virtualClock`
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The previous benchmark (`bench/executionLatency.mjs`) modelled time with a clock whose
 * `wait(ms)` did `t += ms`. That is wrong for concurrency: two waits that in reality OVERLAP
 * (because they were started concurrently) were ADDED to one shared counter, so two concurrent
 * 100 ms waits reported completion at t = 200 ms instead of t = 100 ms. Every "concurrency 2/4"
 * figure it printed was therefore inflated by serialising waits that a real event loop overlaps.
 *
 * A discrete-event scheduler fixes this at the root. `wait(ms)` does NOT advance the clock; it
 * REGISTERS a timer at `now + ms` and returns a promise. The clock only moves when {@link drain}
 * advances it to the NEXT scheduled event. Two timers registered at the same virtual instant for
 * `now + 100` therefore both fire at t = 100 — concurrent waits overlap, exactly as they do on a
 * real event loop, while the run stays deterministic and instant (no real sleeping).
 *
 * This is the same shape as the injected clock the production `KiteBrokerAdapter` accepts
 * (`{ now, wait }`) and the same shape the existing real-waiter test uses, so the REAL adapter's
 * pacer, `waitForResolution` loop and REST-poll cadence run UNMODIFIED on this clock.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * INTERLEAVING MODEL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Async code between awaits runs as microtasks. After firing the timers due at a given instant,
 * {@link drain} yields the microtask queue to completion (via `queueMicrotask` fences) BEFORE
 * advancing to the next instant, so any follow-up `wait`/`schedule` those microtasks register at
 * the current instant is observed and ordered correctly. Ties (same deadline) fire in
 * registration order (FIFO), which matches a stable single-threaded scheduler.
 */

export function createScheduler(start = 0) {
  let now = start;
  let seq = 0;
  /** Pending timers: { at, seq, resolve }. Kept sorted lazily at pop time. */
  const timers = [];

  const guard = (ms, where) => {
    if (!Number.isFinite(ms)) throw new Error(`non-finite scheduler delay in ${where}: ${ms}`);
    return Math.max(0, ms);
  };

  /** Register a timer; returns a promise that resolves when the clock reaches `now + ms`. */
  function wait(ms) {
    const delay = guard(ms, "wait");
    if (delay === 0) {
      // A zero-delay wait must still yield (an await boundary), but not stall time.
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      timers.push({ at: now + delay, seq: seq++, resolve });
    });
  }

  /** Schedule a callback at `now + ms` without a promise (used by timed mocks). */
  function schedule(ms, cb) {
    const delay = guard(ms, "schedule");
    timers.push({ at: now + delay, seq: seq++, resolve: cb });
  }

  function pending() {
    return timers.length;
  }

  /** Yield the microtask queue to quiescence so newly-registered timers are visible. */
  async function flushMicrotasks() {
    // A handful of microtask fences is enough for the adapter's await chains; a bound keeps a
    // pathological callback from spinning forever.
    for (let i = 0; i < 1000; i++) {
      await Promise.resolve();
    }
  }

  /**
   * Advance the clock to the next scheduled event and fire every timer due at that instant,
   * repeating until no timers remain OR `stopWhen()` returns true. Returns the final `now`.
   *
   * `stopWhen` lets a caller stop as soon as the work it awaits has resolved, leaving unrelated
   * far-future timers (e.g. a long reconcile interval) unfired instead of advancing into them.
   */
  async function drain({ stopWhen, maxSteps = 1_000_000 } = {}) {
    let steps = 0;
    // Let anything already queued register its first timers.
    await flushMicrotasks();
    while (timers.length > 0) {
      if (stopWhen && stopWhen()) break;
      if (++steps > maxSteps) throw new Error(`scheduler drain exceeded ${maxSteps} steps (livelock?)`);
      // Find the earliest deadline (FIFO on ties).
      let nextAt = Infinity;
      for (const t of timers) if (t.at < nextAt) nextAt = t.at;
      now = nextAt;
      // Fire ALL timers due at this instant, in registration order.
      const due = timers
        .filter((t) => t.at <= now)
        .sort((a, b) => a.seq - b.seq);
      for (const t of due) {
        const idx = timers.indexOf(t);
        if (idx !== -1) timers.splice(idx, 1);
        t.resolve();
      }
      // Let the woken code run its microtasks (and register follow-up timers) before we move on.
      await flushMicrotasks();
    }
    return now;
  }

  return {
    now: () => now,
    wait,
    schedule,
    pending,
    drain,
    flushMicrotasks,
  };
}
