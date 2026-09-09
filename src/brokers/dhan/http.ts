/**
 * DhanHQ v2 HTTP transport.
 *
 * Owns exactly four concerns, so no endpoint has to re-implement them:
 *   - bounded deadlines (AbortController; `fetch` has no timeout of its own)
 *   - request pacing / rate limiting
 *   - error normalization into the typed classes in errors.ts
 *   - retry policy — READS ONLY
 *
 * THE RETRY RULE IS THE IMPORTANT PART
 * `request()` never retries. `read()` retries a safe subset. `write()` exists as a
 * separate method purely so that "this is a mutation, do not retry it" is visible
 * at every call site rather than being a comment somebody might not read. Blindly
 * re-POSTing an order that timed out is how a four-leg box becomes an eight-leg
 * position, so the transport refuses to make that mistake possible.
 */

import {
  DhanAuthError,
  DhanError,
  DhanNetworkError,
  DhanRateLimitError,
  isRetryableRead,
  normalizeDhanError,
} from "./errors.js";
import { Deadline, type MonotonicClock, monotonicNow } from "../deadline.js";

export const DHAN_API_ROOT = "https://api.dhan.co/v2";
export const DHAN_AUTH_ROOT = "https://auth.dhan.co";

/** The instrument master. Public (no auth), served as CSV. */
export const DHAN_SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";
/** Fallback layout, used when the detailed master is unavailable. */
export const DHAN_SCRIP_MASTER_FALLBACK_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";

export interface DhanHttpConfig {
  /** Reads the current access token, or null when there is no session. */
  accessToken: () => string | null;
  /** The Dhan client id, required by several data endpoints. */
  clientId: () => string;
  /** Per-request deadline (ms). */
  timeoutMs: number;
  /** Minimum gap between requests (ms) — a simple, predictable pacer. */
  minIntervalMs: number;
  /** Attempts for a RETRYABLE READ, including the first. 1 disables retrying. */
  maxReadAttempts: number;
  /**
   * Monotonic clock for deadline/elapsed measurement (Defect 4). Optional so existing
   * config literals keep compiling; defaults to `performance.now()`. Injected by tests to
   * drive deadlines deterministically. NEVER `Date.now()`: durations must use a clock that
   * cannot step backward.
   */
  monotonic?: MonotonicClock;
}

export function dhanHttpConfigFromEnv(overrides: Partial<DhanHttpConfig> = {}): DhanHttpConfig {
  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  return {
    accessToken: () => null,
    clientId: () => process.env.DHAN_CLIENT_ID?.trim() ?? "",
    timeoutMs: num("DHAN_HTTP_TIMEOUT_MS", 8_000, 500, 60_000),
    minIntervalMs: num("DHAN_MIN_INTERVAL_MS", 120, 0, 5_000),
    maxReadAttempts: num("DHAN_MAX_READ_ATTEMPTS", 3, 1, 6),
    ...overrides,
  };
}

interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /**
   * Send the `client-id` header. Several data endpoints require it; the order
   * endpoints carry `dhanClientId` in the JSON body instead.
   */
  withClientId?: boolean;
  /** Absolute URL override (used for the auth host and the scrip master). */
  absoluteUrl?: string;
  /** Extra headers — used only by the auth flow's app_id/app_secret pair. */
  headers?: Record<string, string>;
  /** Skip the Authorization header (auth + public endpoints). */
  anonymous?: boolean;
  /**
   * THE FINAL SYNCHRONOUS SEND GUARD (Defect 3).
   *
   * Invoked at the LAST synchronous instant before `fetch()` — after the pacing queue and
   * after the residual-interval sleep, with NO `await` between the call and the network
   * send. Throwing here PROVES no HTTP request was transmitted: the queued write is refused
   * before it reaches the wire. This is what closes the window in which a POST could sit in
   * the lower pacing queue and fire after entry was already disarmed. The adapter passes a
   * callback that re-checks entry authorization / reservation / deadline; a thrown
   * `BrokerPreSubmitRefusedError` propagates unchanged and is NEVER an ambiguous submission.
   */
  beforeSend?: () => void;
  /**
   * ABSOLUTE end-to-end deadline (Defect 4), on the MONOTONIC clock.
   *
   * Carried through queue wait, pacing sleep, the network call AND the body read, and
   * shared across read retries so the total budget is never restarted per layer. When
   * omitted, `request()` derives one from `cfg.timeoutMs` so existing callers are bounded
   * exactly as before — but only for a SINGLE attempt; `read()` builds ONE deadline and
   * passes it down so all its retries share the one budget.
   */
  deadline?: Deadline;
}

export class DhanHttp {
  /**
   * Serialized pacing tail.
   *
   * Every request chains onto the previous one and then waits out the residual
   * interval, which gives a predictable request rate without a token bucket. Dhan
   * publishes per-endpoint limits; pacing conservatively at the transport keeps us
   * clear of them without each endpoint tracking its own budget.
   */
  private tail: Promise<unknown> = Promise.resolve();
  /** Last request START, on the MONOTONIC clock (Defect 4) — NOT wall-clock Date.now(). */
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private cfg: DhanHttpConfig) {}

  /** The monotonic clock in force. Injectable via config; defaults to performance.now(). */
  private now(): number {
    return (this.cfg.monotonic ?? monotonicNow)();
  }

  /** Swap in a new token reader (used when a session is established or cleared). */
  setAccessTokenReader(reader: () => string | null): void {
    this.cfg = { ...this.cfg, accessToken: reader };
  }

  private headersFor(opts: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    };
    if (!opts.anonymous) {
      const token = this.cfg.accessToken();
      if (!token) {
        throw new DhanAuthError("No Dhan session: connect Dhan before calling its API.");
      }
      // Dhan v2 authenticates with a bare `access-token` header, not a Bearer scheme.
      headers["access-token"] = token;
    }
    if (opts.withClientId) {
      const clientId = this.cfg.clientId();
      if (!clientId) {
        throw new DhanError("DHAN_CLIENT_ID is not configured.", 0, "CONFIG");
      }
      headers["client-id"] = clientId;
    }
    return headers;
  }

  /**
   * One attempt. Never retries — the retry decision belongs to the caller, which
   * is the only place that knows whether the call is a read or a mutation.
   *
   * DEADLINE MODEL (Defect 4): a single absolute `Deadline` bounds the WHOLE attempt —
   * the wait in the serialized pacing queue, the residual pacing sleep, the network round
   * trip AND the response-body read. It is created once (or supplied by `read()` so retries
   * share it) and every stage below consults it, so the total time can never exceed the
   * budget regardless of how much of it the queue already consumed.
   *
   * SEND GUARD (Defect 3): `opts.beforeSend` fires at the final synchronous instant before
   * `fetch()` — after both waits — with no `await` in between, so a queued write is refused
   * BEFORE transmission if entry was disarmed while it waited.
   */
  async request<T>(opts: RequestOptions): Promise<T> {
    const headers = this.headersFor(opts);
    const url = opts.absoluteUrl ?? `${DHAN_API_ROOT}${opts.path}`;
    // One deadline for the entire attempt. Derived from cfg.timeoutMs when the caller did
    // not supply one, so a bare `request()` is bounded exactly as before — but as a SINGLE
    // absolute budget rather than a fresh timer per layer.
    const deadline = opts.deadline ?? Deadline.in(this.cfg.timeoutMs, () => this.now());

    const run = async (): Promise<T> => {
      // QUEUE + PACING WAIT, bounded by the deadline (Defect 4). If the deadline already
      // expired while this write sat in the serialized tail, abandon it now rather than
      // sending it late — an expired queued mutation must NEVER transmit.
      if (deadline.expired()) {
        throw new DhanNetworkError(
          `Dhan request abandoned before send: deadline (${deadline.budgetMs}ms) expired while queued (${opts.method} ${opts.path}).`,
        );
      }
      const gap = this.cfg.minIntervalMs - (this.now() - this.lastAt);
      if (gap > 0) {
        // Never sleep past the deadline; a pacing wait must not itself blow the budget.
        await sleep(Math.min(gap, deadline.timerMs()));
        if (deadline.expired()) {
          throw new DhanNetworkError(
            `Dhan request abandoned before send: deadline (${deadline.budgetMs}ms) expired during pacing (${opts.method} ${opts.path}).`,
          );
        }
      }

      // FINAL SYNCHRONOUS SEND GUARD (Defect 3). LAST statement before `fetch` — no `await`
      // follows until the network call itself. A throw here proves nothing was transmitted.
      // Placed AFTER the deadline/pacing checks so it re-evaluates entry authority against
      // the freshest possible moment.
      opts.beforeSend?.();

      this.lastAt = this.now();

      // `fetch` has no timeout, so an unresponsive socket would hang forever and wedge the
      // pacing tail behind it. The controller is armed for the REMAINING budget, and — the
      // Defect-4 fix — the SAME controller stays armed across the body read below, so
      // `res.text()` can no longer hang unbounded after the headers arrive.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadline.timerMs());
      try {
        let res: Response;
        try {
          res = await fetch(url, {
            method: opts.method,
            headers,
            signal: controller.signal,
            ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          });
        } catch (err) {
          // Abort, DNS failure, socket reset — no response, so for a mutation the
          // outcome is genuinely UNKNOWN.
          const reason = err instanceof Error && err.name === "AbortError"
            ? `Dhan request timed out after ${deadline.budgetMs}ms (${opts.method} ${opts.path})`
            : `Dhan request failed (${opts.method} ${opts.path}): ${err instanceof Error ? err.message : String(err)}`;
          throw new DhanNetworkError(reason);
        }

        // BODY READ, still covered by the SAME deadline (Defect 4). Previously the timer was
        // cleared the instant headers arrived and this read was unbounded; now a stalled body
        // aborts the controller and rejects, exactly like a stalled header.
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          const reason = err instanceof Error && err.name === "AbortError"
            ? `Dhan response body timed out after ${deadline.budgetMs}ms (${opts.method} ${opts.path})`
            : `Dhan response body read failed (${opts.method} ${opts.path}): ${err instanceof Error ? err.message : String(err)}`;
          throw new DhanNetworkError(reason);
        }

        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // A non-JSON body on an error status is normal (gateway HTML, etc).
            parsed = { message: text.slice(0, 500) };
          }
        }

        if (!res.ok) {
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get("retry-after"));
            throw new DhanRateLimitError(
              `Dhan rate limit hit (${opts.method} ${opts.path}).`,
              Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
              parsed,
            );
          }
          throw normalizeDhanError(
            res.status,
            parsed,
            `Dhan API error ${res.status} (${opts.method} ${opts.path}).`,
          );
        }

        // Dhan sometimes wraps a failure in a 200 with a status field. Treat that as
        // an error rather than returning an empty success to the caller.
        const record = (parsed ?? {}) as Record<string, unknown>;
        if (typeof record.status === "string" && record.status.toLowerCase() === "failed") {
          throw normalizeDhanError(400, parsed, `Dhan API reported failure (${opts.path}).`);
        }
        return parsed as T;
      } finally {
        clearTimeout(timer);
      }
    };

    // Chain onto the tail so requests are paced rather than bursting.
    const scheduled = this.tail.then(run, run);
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }

  /**
   * A READ, with bounded retries for transient failures.
   *
   * Safe because a read has no side effects: repeating it can waste a request but
   * cannot create an order or move a position.
   *
   * DEADLINE (Defect 4): ONE absolute deadline is built here and threaded into every
   * attempt AND every backoff sleep, so `maxReadAttempts` retries share a single budget
   * instead of each restarting a fresh `timeoutMs`. Previously N attempts could take up to
   * N × timeoutMs plus all the backoffs; now the whole read is bounded by the one budget,
   * and a caller may pass its OWN (tighter) deadline for a protective read. The default
   * multiplies `timeoutMs` by the attempt count so a healthy read is not starved of its
   * historical budget while a stalled one is still capped.
   */
  async read<T>(opts: Omit<RequestOptions, "method"> & { method?: "GET" | "POST" }): Promise<T> {
    const method = opts.method ?? "GET";
    const deadline = opts.deadline
      ?? Deadline.in(this.cfg.timeoutMs * this.cfg.maxReadAttempts, () => this.now());
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= this.cfg.maxReadAttempts; attempt++) {
      try {
        return await this.request<T>({ ...opts, method, deadline });
      } catch (err) {
        lastErr = err;
        if (!isRetryableRead(err) || attempt === this.cfg.maxReadAttempts) throw err;
        // Out of budget: stop retrying now rather than sleeping into an already-expired
        // deadline and then failing anyway.
        if (deadline.expired()) throw err;
        // Honour Retry-After when Dhan supplied one; otherwise linear backoff. Either way,
        // never sleep past the shared deadline.
        const waitMs = err instanceof DhanRateLimitError && err.retryAfterSec
          ? Math.min(10_000, err.retryAfterSec * 1000)
          : attempt * 300;
        await sleep(Math.min(waitMs, deadline.timerMs()));
      }
    }
    throw lastErr;
  }

  /**
   * A MUTATION. Exactly one attempt, always.
   *
   * Named separately from `request` so that every order-placing call site reads as
   * a deliberate single shot. If this throws a `DhanNetworkError` or a
   * `DhanRateLimitError`, the outcome is UNKNOWN and the caller MUST reconcile
   * (by correlation id) rather than submit again.
   *
   * Accepts `beforeSend` and `deadline` verbatim so the adapter can (a) place its final
   * synchronous entry guard at the true send boundary (Defect 3) and (b) impose an absolute
   * end-to-end budget on the placement (Defect 4). A single attempt means there is no retry
   * to restart, so the deadline simply bounds this one shot.
   */
  async write<T>(opts: Omit<RequestOptions, "method"> & { method: "POST" | "PUT" | "DELETE" }): Promise<T> {
    return this.request<T>(opts);
  }
}

function sleep(ms: number): Promise<void> {
  // NOT unref'd. An unref'd timer does not hold the event loop open, so awaiting one
  // can never resolve if nothing else is pending — the await simply hangs. `unref` is
  // right for a background retry timer (see the feed's reconnect), and wrong for a
  // delay something is waiting on.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
