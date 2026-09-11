/**
 * EVIDENCE TIMING — how a broker-sourced economic figure is read, aged, and bound to identity.
 *
 * WHY THIS MODULE EXISTS (the reported defect)
 *
 * `CentralBoxExecutionGateway.evaluateEntryEconomics()` used to do this:
 *
 *     const now = this.now();                        // ← captured BEFORE the reads
 *     const funds  = await this.deps.funds();        // ← engine stamps observedAt AFTER resolving
 *     const margin = await this.deps.plannedMargin(); // ← same
 *     brokerFigure({ now, observedAt: funds.observedAt, ... })   // age = now - observedAt  < 0
 *
 * Every real broker round trip takes time, so `observedAt` was always LATER than `now`, the age was
 * always NEGATIVE, and `brokerFigure()`'s `age >= 0` freshness rule downgraded a perfectly fresh
 * response to "stale". The economic gate then refused valid entries. A frozen test clock hid it
 * because the stub stamped `observedAt === now`.
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *  1. ONE COHERENT CLOCK MODEL. A reading is a pair: monotonic (for durations) + wall (for audit).
 *     {@link EvidenceInstant}. They are never subtracted from each other.
 *  2. AGE IS A MONOTONIC DURATION. `performance.now()` cannot step backward, so an NTP correction
 *     during a read can neither fabricate staleness nor erase it. Wall time is retained only for
 *     the audit record. When a source can only supply a wall timestamp (a cache, a restart, a
 *     replica) the wall difference is used and LABELLED as such, because a cross-process timestamp
 *     has no comparable monotonic origin.
 *  3. THE EVALUATION INSTANT IS CAPTURED AFTER THE READS. {@link readEvidence} stamps each
 *     observation when it RESOLVES; the caller stamps the evaluation instant once every read has
 *     settled. Ages are therefore >= 0 by construction.
 *  4. READS ARE BOUNDED. A stalled broker request cannot hang admission: the read is raced against
 *     a deadline and a timeout yields an explicit `unavailable` observation with a reason, never a
 *     value and never an unbounded await.
 *  5. NOTHING IS RESTAMPED. A cache hit keeps the age it really has. There is no code path here
 *     that assigns "now" to a value it did not just observe.
 *  6. EVIDENCE IS BOUND TO WHAT IT IS EVIDENCE ABOUT — broker, account, session, and (for a margin
 *     figure) the exact order plan. A figure read for one account/session/plan is not evidence
 *     about another, so it is invalidated rather than reused.
 *
 * PURITY. Nothing here performs I/O of its own or reads a global clock: the clock and the read
 * function are injected, which is what makes the deterministic tests possible.
 */

import type { BrokerOrderRequest } from "./brokerAdapter.js";

/** A moment read on both clocks at once. `mono` is for durations, `wall` is for audit. */
export interface EvidenceInstant {
  /** Monotonic ms from an arbitrary process-local origin. DURATIONS ONLY. */
  readonly mono: number;
  /** Wall-clock ms since the Unix epoch. AUDIT/DISPLAY ONLY. */
  readonly wall: number;
}

/** The clock pair an evidence read is stamped against. Injectable for determinism. */
export interface EvidenceClock {
  mono(): number;
  wall(): number;
}

/**
 * WHO the evidence is about.
 *
 * A funds figure is a statement about one broker account in one authenticated session. If any of
 * these change while the read is in flight — an operator switched broker, a token was rotated onto
 * a different account, the session was restarted — the figure describes something other than what
 * is about to be traded, and must not admit an entry.
 */
export interface EvidenceIdentity {
  readonly broker: string;
  /** A non-secret reference to the account (masked id / hash). Null when the broker cannot tell us. */
  readonly account_ref: string | null;
  /** The authenticated session / token generation this figure was read under. */
  readonly session_id: string | null;
}

/** Human-readable identity mismatch, or null when the two identities are compatible. */
export function identityMismatch(
  observed: EvidenceIdentity | null,
  current: EvidenceIdentity | null,
): string | null {
  if (!observed || !current) return null;
  if (observed.broker !== current.broker) {
    return `broker changed ${observed.broker} → ${current.broker} during the evidence read`;
  }
  // A null account_ref means "the broker did not tell us", which cannot be compared. Only two
  // KNOWN and DIFFERENT references are a mismatch — inventing a mismatch from an unknown would
  // block entry on missing metadata rather than on real evidence.
  if (
    observed.account_ref !== null &&
    current.account_ref !== null &&
    observed.account_ref !== current.account_ref
  ) {
    return `account changed ${observed.account_ref} → ${current.account_ref} during the evidence read`;
  }
  if (
    observed.session_id !== null &&
    current.session_id !== null &&
    observed.session_id !== current.session_id
  ) {
    return `session changed ${observed.session_id} → ${current.session_id} during the evidence read`;
  }
  return null;
}

/** Why an evidence read produced no value. Distinct causes, never collapsed into "missing". */
export type EvidenceFailure = "absent" | "timeout" | "threw" | "null_value";

/**
 * One evidence read, with everything needed to judge it.
 *
 * `value` is null whenever `failure` is set. A null value is "UNKNOWN", never "zero".
 */
export interface TimedObservation<T> {
  readonly value: T | null;
  /** When the value was observed — stamped at RESOLUTION, never before the read started. */
  readonly at: EvidenceInstant | null;
  /**
   * The wall timestamp the SOURCE claims, when it supplies one. May differ from `at.wall` for a
   * cache hit or a value carried across a restart; that difference is the real age of the datum and
   * is preserved rather than smoothed away.
   */
  readonly source_observed_at_wall: number | null;
  readonly failure: EvidenceFailure | null;
  readonly detail: string | null;
  /**
   * The identity the read was ISSUED under. This is what the answer is evidence ABOUT, and what a
   * later comparison against the current identity must use.
   */
  readonly identity: EvidenceIdentity | null;
  /** The identity when the read RESOLVED. Diagnostics: shows a switch that happened mid-flight. */
  readonly identity_at_resolution: EvidenceIdentity | null;
  /** Monotonic ms the read itself took. For instrumentation and pacing. */
  readonly elapsed_ms: number | null;
}

/**
 * Read one piece of evidence with a HARD bound.
 *
 * The read is raced against `timeoutMs` on the injected clock. A timeout does not cancel the
 * underlying request (no broker facility here is cancellable), but it does stop admission waiting
 * on it, which is the property that matters: a stalled funds endpoint must not be able to hold an
 * entry decision open indefinitely.
 *
 * The observation instant is stamped when the read RESOLVES. That is the whole point: the caller
 * then stamps its evaluation instant afterwards, so age >= 0 by construction.
 */
export async function readEvidence<T>(args: {
  /** The broker read. Absent (undefined) is reported as `absent`, not as a failure to retry. */
  readonly read: (() => Promise<T | null>) | undefined;
  readonly timeoutMs: number;
  readonly clock: EvidenceClock;
  /**
   * Identity provider.
   *
   * SAMPLED AT ISSUE TIME, before the read starts. That is the identity the request was made under,
   * and therefore the identity the answer is about. Sampling it at RESOLUTION instead would be
   * useless: a broker switch or token rotation that happens while the read is in flight would be
   * baked into the observation, and comparing it against the (identically changed) current identity
   * would always agree. The resolution-time identity is captured separately for diagnostics.
   */
  readonly identity: () => EvidenceIdentity | null;
  /** Extracts the source's own claimed wall timestamp, when it has one. */
  readonly sourceObservedAtWall?: (value: T) => number | null;
  readonly label: string;
}): Promise<TimedObservation<T>> {
  if (!args.read) {
    return {
      value: null,
      at: null,
      source_observed_at_wall: null,
      failure: "absent",
      detail: `no ${args.label} evidence source is wired`,
      identity: null,
      identity_at_resolution: null,
      elapsed_ms: null,
    };
  }
  // THE IDENTITY THE READ IS ISSUED UNDER. Captured before a single byte goes out.
  const issuedUnder = safeIdentity(args.identity);
  const startedMono = args.clock.mono();
  const budget = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 1;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), budget);
    // Never hold the event loop open for a bound we are only using as a race.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  let settled: T | null | { __timeout: true };
  try {
    settled = await Promise.race([args.read(), timeout]);
  } catch (error) {
    clearTimeout(timer);
    return {
      value: null,
      at: null,
      source_observed_at_wall: null,
      failure: "threw",
      detail: `${args.label} evidence source threw: ${error instanceof Error ? error.message : String(error)}`,
      identity: issuedUnder,
      identity_at_resolution: safeIdentity(args.identity),
      elapsed_ms: monoElapsed(startedMono, args.clock.mono()),
    };
  }
  clearTimeout(timer);

  if (settled !== null && typeof settled === "object" && "__timeout" in settled) {
    return {
      value: null,
      at: null,
      source_observed_at_wall: null,
      failure: "timeout",
      detail: `${args.label} evidence read timed out after ${budget}ms; treated as UNAVAILABLE (unknown), never as ₹0`,
      identity: issuedUnder,
      identity_at_resolution: safeIdentity(args.identity),
      elapsed_ms: monoElapsed(startedMono, args.clock.mono()),
    };
  }

  const value = settled as T | null;
  const at: EvidenceInstant = { mono: args.clock.mono(), wall: args.clock.wall() };
  if (value === null || value === undefined) {
    return {
      value: null,
      at,
      source_observed_at_wall: null,
      failure: "null_value",
      detail: `${args.label} evidence source returned no figure; treated as UNKNOWN`,
      identity: issuedUnder,
      identity_at_resolution: safeIdentity(args.identity),
      elapsed_ms: monoElapsed(startedMono, at.mono),
    };
  }
  return {
    value,
    at,
    source_observed_at_wall: args.sourceObservedAtWall?.(value) ?? null,
    failure: null,
    detail: null,
    identity: issuedUnder,
    identity_at_resolution: safeIdentity(args.identity),
    elapsed_ms: monoElapsed(startedMono, at.mono),
  };
}

/** Read an identity provider without letting it decide by throwing. A throw yields "unknown". */
function safeIdentity(provider: () => EvidenceIdentity | null): EvidenceIdentity | null {
  try {
    return provider();
  } catch {
    return null;
  }
}

/** Monotonic difference, or null when the pair is missing or inverted (a bug, not a negative age). */
export function monoElapsed(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const delta = to - from;
  return delta >= 0 ? delta : null;
}

/**
 * A stable fingerprint of the exact four-leg order plan the evidence was fetched for.
 *
 * A basket-margin figure is a statement about a SPECIFIC set of contracts, sides, quantities and
 * limit prices. If a chase re-prices a leg, or the quantity changes, the figure is no longer
 * evidence about what is about to be sent. Comparing fingerprints is how the send boundary detects
 * that without having to re-fetch.
 *
 * Deliberately includes only the fields that change the margin/funding requirement, and is order-
 * independent (sorted) so hedge-first re-ordering alone does not invalidate evidence.
 */
export function orderPlanFingerprint(requests: readonly BrokerOrderRequest[]): string {
  return requests
    .map((r) =>
      [
        r.role,
        r.exchange,
        r.tradingsymbol,
        r.token,
        r.side,
        r.quantity,
        // Limit price to 2dp: the margin requirement is a function of the price actually sent.
        Number.isFinite(r.pricing.limit_price) ? r.pricing.limit_price.toFixed(2) : "?",
      ].join(":"),
    )
    .sort()
    .join("|");
}

/** How a timed observation ages against a freshness bound. */
export type EvidenceStatus = "usable" | "stale" | "invalid" | "unavailable";

export interface AgedEvidence {
  readonly status: EvidenceStatus;
  /** Age in ms at the evaluation instant. Never negative; null when it cannot be computed. */
  readonly age_ms: number | null;
  /** True when the age came from the monotonic clock (in-process), false when from wall deltas. */
  readonly age_is_monotonic: boolean;
  readonly note: string;
}

/**
 * Age an observation at the evaluation instant and classify it.
 *
 * ORDER OF PREFERENCE for the age:
 *   1. The source's own claimed wall timestamp, when it is materially OLDER than our observation
 *      (a cache hit / a value carried across a restart). That is the datum's real age and must not
 *      be hidden. Non-monotonic by nature, and labelled so.
 *   2. Monotonic difference between the observation and the evaluation instant. The normal case.
 *
 * EXPLICIT CASES, each with its own status:
 *   - no observation at all                       → unavailable
 *   - non-finite / missing timestamps             → invalid
 *   - source timestamp MATERIALLY in the future   → invalid  (a broken clock, not a fresh figure)
 *   - age > bound                                 → stale
 *   - identity changed during the read            → invalid
 */
export function ageEvidence(args: {
  readonly observation: TimedObservation<unknown>;
  readonly evaluatedAt: EvidenceInstant;
  readonly maxAgeMs: number;
  /** Tolerance for a source clock slightly ahead of ours before we call it invalid. */
  readonly futureSkewGraceMs: number;
  readonly currentIdentity: EvidenceIdentity | null;
  readonly label: string;
}): AgedEvidence {
  const { observation } = args;
  if (observation.failure !== null || observation.at === null) {
    return {
      status: "unavailable",
      age_ms: null,
      age_is_monotonic: false,
      note:
        observation.detail ??
        `no ${args.label} figure obtained; treated as UNKNOWN, never as ₹0`,
    };
  }

  const mismatch = identityMismatch(observation.identity, args.currentIdentity);
  if (mismatch) {
    return {
      status: "invalid",
      age_ms: monoElapsed(observation.at.mono, args.evaluatedAt.mono),
      age_is_monotonic: true,
      note: `${args.label} figure is not evidence about the account about to be traded: ${mismatch}`,
    };
  }

  if (!Number.isFinite(observation.at.mono) || !Number.isFinite(args.evaluatedAt.mono)) {
    return {
      status: "invalid",
      age_ms: null,
      age_is_monotonic: false,
      note: `${args.label} figure carries a non-finite observation time; cannot be aged, so not usable`,
    };
  }

  const sourceWall = observation.source_observed_at_wall;
  if (sourceWall !== null && !Number.isFinite(sourceWall)) {
    return {
      status: "invalid",
      age_ms: null,
      age_is_monotonic: false,
      note: `${args.label} figure carries a non-finite source timestamp; not usable`,
    };
  }

  // A source clock MATERIALLY ahead of ours is a broken clock, not fresh evidence.
  if (sourceWall !== null && sourceWall - observation.at.wall > args.futureSkewGraceMs) {
    const ahead = sourceWall - observation.at.wall;
    return {
      status: "invalid",
      age_ms: null,
      age_is_monotonic: false,
      note:
        `${args.label} figure is stamped ${ahead}ms in the FUTURE relative to this host ` +
        `(grace ${args.futureSkewGraceMs}ms); a clock this far out cannot be aged, so the figure is ` +
        "treated as INVALID rather than fresh",
    };
  }

  const monoAge = monoElapsed(observation.at.mono, args.evaluatedAt.mono);
  // A CACHE HIT: the source says it observed this materially before we received it. That extra age
  // is real and is added — this is the "never revive old evidence" rule.
  const sourceLag =
    sourceWall !== null && Number.isFinite(sourceWall)
      ? Math.max(0, observation.at.wall - sourceWall)
      : 0;
  const usedSourceLag = sourceLag > args.futureSkewGraceMs;
  const age = monoAge === null ? null : monoAge + (usedSourceLag ? sourceLag : 0);

  if (age === null) {
    return {
      status: "invalid",
      age_ms: null,
      age_is_monotonic: false,
      note:
        `${args.label} figure could not be aged (inverted monotonic readings — a clock fault); ` +
        "treated as INVALID rather than assumed fresh",
    };
  }
  if (age > args.maxAgeMs) {
    return {
      status: "stale",
      age_ms: age,
      age_is_monotonic: !usedSourceLag,
      note:
        `${args.label} figure is ${age}ms old, over the ${args.maxAgeMs}ms freshness bound; ` +
        `treated as STALE and not usable for admission${usedSourceLag ? " (age includes the source's own cache lag)" : ""}`,
    };
  }
  return {
    status: "usable",
    age_ms: age,
    age_is_monotonic: !usedSourceLag,
    note: `observed ${age}ms ago, within the ${args.maxAgeMs}ms freshness bound`,
  };
}
