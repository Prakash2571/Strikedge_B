/**
 * HONEST STARTUP READINESS — the process-wide state machine.
 *
 * WHY THIS EXISTS
 * The old boot sequence called `app.listen()` and only THEN ran `boot()`, while
 * `GET /api/health` unconditionally answered `{ ok: true }`. So the health check
 * reported "ok" during the window in which migrations were still running, the
 * authoritative broker had not been restored, Box durable state had not been
 * adopted and unresolved orders had not been reconciled — and every mutating route
 * was already live. A supervisor or load balancer would route traffic (and an
 * operator could arm a session) against a process that had adopted no positions.
 *
 * This module is the single source of truth for "is the process operationally
 * ready?". It is deliberately tiny and has NO dependency on express, pg, the
 * engine or any broker, so it is unit-testable in complete isolation.
 *
 * THE STATES
 *   starting        the process is booting; NOT ready; mutations refused
 *   ready           boot finished successfully; ready; mutations allowed
 *   failed          boot threw; NEVER ready; mutations refused; process exits non-zero
 *   shutting_down   a signal arrived; NOT ready; mutations refused
 *
 * LEGAL TRANSITIONS (everything else is refused)
 *   starting      -> ready | failed | shutting_down
 *   ready         -> shutting_down
 *   failed        -> (terminal; only shutting_down is tolerated so a failed boot
 *                     can still drive the shutdown steps to close resources)
 *   shutting_down -> (terminal)
 *
 * The single most important refusal is `failed -> ready`: a boot that failed must
 * never be able to flip itself ready afterwards. `ready` is also entered EXACTLY
 * ONCE — a second `starting -> ready` is refused so a double boot cannot be masked.
 */

export type ReadinessState = "starting" | "ready" | "failed" | "shutting_down";

/**
 * The set of states any given state may transition INTO. Absence from this map's
 * value array means the transition is illegal and will be refused.
 */
const LEGAL_TRANSITIONS: Record<ReadinessState, readonly ReadinessState[]> = {
  starting: ["ready", "failed", "shutting_down"],
  // A ready process can only ever move to shutting_down. It can never go back to
  // starting and never spontaneously fail — a runtime fault exits the process.
  ready: ["shutting_down"],
  // `failed` is terminal for readiness. We DO allow it to move to shutting_down so
  // the boot-failure path can reuse the ordinary shutdown steps to close the
  // partially-initialised resources before the process exits non-zero.
  failed: ["shutting_down"],
  // shutting_down is fully terminal.
  shutting_down: [],
};

/** How long a recorded failure reason may be. Bounded so a huge or secret-laden
 *  error string can never be stored or leaked through diagnostics. */
const MAX_REASON_LENGTH = 200;

export interface ReadinessSnapshot {
  state: ReadinessState;
  /** True only when `state === "ready"`. The one boolean callers should trust. */
  ready: boolean;
  /** Bounded, non-secret reason for a `failed` transition; null otherwise. */
  failureReason: string | null;
}

/**
 * Reduce an arbitrary reason (which may be an Error carrying a stack, a SQL
 * fragment or a token) to a bounded, single-line, non-secret string.
 *
 * We take only the message, collapse whitespace to single spaces (so a multi-line
 * stack trace cannot smuggle detail through), and hard-truncate. This is the ONLY
 * place a failure reason is normalised, so there is one rule for all of them.
 */
export function sanitizeFailureReason(reason: unknown): string {
  let text: string;
  if (reason instanceof Error) text = reason.message;
  else if (typeof reason === "string") text = reason;
  else text = String(reason);
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "unspecified failure";
  return collapsed.length > MAX_REASON_LENGTH
    ? `${collapsed.slice(0, MAX_REASON_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The process-wide readiness state machine.
 *
 * A single transition method enforces the legal-transition table above and refuses
 * everything else. Nothing outside this class mutates the state.
 */
export class ReadinessController {
  private state: ReadinessState = "starting";
  private failureReason: string | null = null;

  /** The current coarse state. */
  getState(): ReadinessState {
    return this.state;
  }

  /** True only in the `ready` state. */
  isReady(): boolean {
    return this.state === "ready";
  }

  /**
   * A mutation may proceed only when the process is fully ready. `starting`,
   * `failed` and `shutting_down` all refuse mutations.
   */
  mutationsAllowed(): boolean {
    return this.state === "ready";
  }

  /** A contentless snapshot safe to serve on an unauthenticated endpoint. */
  snapshot(): ReadinessSnapshot {
    return {
      state: this.state,
      ready: this.state === "ready",
      failureReason: this.failureReason,
    };
  }

  /**
   * Attempt a transition. Returns true if it was applied, false if it was refused
   * as illegal. Refusing is silent to the caller's control flow on purpose: a
   * double `shutting_down` (SIGTERM then SIGINT) must be a harmless no-op, not a
   * throw that crashes the signal handler.
   *
   * `reason` is recorded (sanitised) only for a transition INTO `failed`.
   */
  transition(to: ReadinessState, reason?: unknown): boolean {
    if (to === this.state) {
      // A self-transition is a no-op, never an error. In particular a second
      // `ready` is refused as a state change (see below) — but landing here first
      // for `shutting_down -> shutting_down` keeps repeated signals harmless.
      return false;
    }
    const allowed = LEGAL_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      return false;
    }
    if (to === "failed") {
      this.failureReason = sanitizeFailureReason(reason);
    }
    this.state = to;
    return true;
  }

  /**
   * Convenience wrappers making the call sites in index.ts read as intent rather
   * than as raw state names. Each returns whether the transition was applied.
   */
  markReady(): boolean {
    return this.transition("ready");
  }

  markFailed(reason: unknown): boolean {
    // If we are already failed, keep the FIRST reason (it is the root cause); a
    // later teardown error should not overwrite why boot failed.
    if (this.state === "failed") return false;
    return this.transition("failed", reason);
  }

  markShuttingDown(): boolean {
    return this.transition("shutting_down");
  }
}
