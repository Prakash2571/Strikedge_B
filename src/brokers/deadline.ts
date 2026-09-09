/**
 * MONOTONIC, ABSOLUTE request deadlines for the broker transports.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 *
 * Both broker transports (Dhan's DhanHttp, Zerodha's KiteHttpTransport) had the same
 * three latent defects around time:
 *
 *   1. They measured elapsed time with `Date.now()` — WALL CLOCK. A wall clock can step
 *      backward (NTP correction, a leap-second smear, an operator setting the time) and
 *      then an "elapsed" reading goes negative or jumps, which either bypasses a deadline
 *      or fires it early. On the order path, "bypasses a deadline" means a POST that
 *      should have been abandoned is transmitted late.
 *
 *   2. They restarted the FULL timeout budget at every layer — the pacing wait, the
 *      network wait, each read retry — so the true worst-case time to give up was the
 *      sum of every layer's budget, not the budget the caller asked for. A caller with a
 *      protective action to take could wait far longer than it believed.
 *
 *   3. The AbortController deadline covered `fetch` (headers) but NOT the body read that
 *      followed it, so `await res.text()` was completely unbounded.
 *
 * A `Deadline` is an ABSOLUTE point on the monotonic clock. It is created ONCE at the top
 * of an operation and passed DOWN through pacing, the network call, the body read and any
 * retries. Every layer asks the same object "how long until you expire?", so the total
 * wall-clock spent can never exceed the original budget regardless of how many layers a
 * request passes through. This is the property the old per-layer `timeoutMs` could not
 * provide.
 *
 * MONOTONIC SOURCE: `performance.now()` returns a `DOMHighResTimeStamp` in milliseconds
 * that never runs backward and is unaffected by wall-clock changes. It is the right clock
 * for measuring a DURATION; `Date.now()` is only right for stamping an absolute calendar
 * time (which is why the adapters still use `Date.now()` for `created_at`/`updated_at`).
 */

/** The monotonic clock the transports use to measure durations. Injectable for tests. */
export type MonotonicClock = () => number;

/** The default monotonic clock — `performance.now()`, in milliseconds, never decreasing. */
export const monotonicNow: MonotonicClock = () => performance.now();

/**
 * An absolute expiry on the monotonic clock.
 *
 * Created once and threaded through every layer of a request. `remainingMs()` is what a
 * layer consults before it waits or aborts, so a request that has already overspent its
 * budget in pacing gets ZERO (or negative) remaining for the network call and is abandoned
 * rather than transmitted late.
 */
export class Deadline {
  private constructor(
    private readonly clock: MonotonicClock,
    /** Absolute monotonic time (ms) at which this deadline expires. */
    readonly expiresAt: number,
    /** The original total budget, retained for diagnostics/messages. */
    readonly budgetMs: number,
  ) {}

  /**
   * Start a deadline `budgetMs` from now on the monotonic clock.
   *
   * A non-finite or non-positive budget is clamped to a 1ms floor: a zero budget must
   * still be a real, already-essentially-expired deadline rather than "no deadline",
   * because "no deadline" is exactly the unbounded-wait bug this type removes.
   */
  static in(budgetMs: number, clock: MonotonicClock = monotonicNow): Deadline {
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 1;
    return new Deadline(clock, clock() + budget, budget);
  }

  /**
   * Wrap an already-chosen absolute expiry. Used when a caller carries its own clock
   * (the adapters inject a virtual clock in tests) and wants a deadline anchored to it.
   */
  static at(expiresAt: number, budgetMs: number, clock: MonotonicClock = monotonicNow): Deadline {
    return new Deadline(clock, expiresAt, budgetMs);
  }

  /** Milliseconds until expiry. NEGATIVE once expired — callers clamp when they need >= 0. */
  remainingMs(): number {
    return this.expiresAt - this.clock();
  }

  /** Whether the deadline has passed. */
  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /**
   * The AbortController timeout to use for a `fetch`/body read RIGHT NOW: the remaining
   * budget, floored at 1ms so `setTimeout` always fires (a 0/negative delay is coerced to
   * the next tick and can race a stalled socket). Never larger than the remaining budget,
   * so the network wait is bounded by the ABSOLUTE deadline, not a fresh per-attempt one.
   */
  timerMs(): number {
    return Math.max(1, this.remainingMs());
  }
}
