/**
 * THE LIVE ENTRY "STILL WANTED" GUARD — one pure decision, re-evaluated at five checkpoints.
 *
 * THE DEFECT THIS CLOSES. The coordinator composes an ownership-aware `stillWanted` predicate
 * (`executionCoordinator.ownershipGuard`, which folds the caller's own predicate together with
 * "do we still hold the reservation lease") and hands it to the gateway. The live branch of
 * `CentralBoxExecutionGateway.simulateLeggingEntry` never consulted it. Only the PAPER simulator
 * did. So in live mode a Box whose lease had been lost, whose scanner decision had gone stale, or
 * whose entry had been disarmed while its legs sat in broker pacing, still POSTed every leg.
 *
 * WHY A PURE FUNCTION. The predicate is consulted from three different layers (gateway, order
 * manager dequeue, adapter pre-POST callback) and each layer knows a different subset of the
 * facts. Centralising the DECISION here means the five checkpoints cannot drift apart, and the
 * refusal reason is identical wherever it is taken — which is what makes the durable
 * `local_pre_submit_refusal` provenance readable after the fact.
 *
 * FAIL CLOSED. Every input is a positive assertion ("this is still true"). An absent or throwing
 * input is treated as false by the callers, because an unprovable entry permission is not an
 * entry permission.
 *
 * COVERAGE IS THE SECOND DEFECT THIS CLOSES. A dependent uncovered SELL used to be authorised
 * whenever no BUY hedge was NAMED as failed (`hedgeFailure === null`). That is a failure signal,
 * not a coverage signal: a hedge that returned CANCELLED with zero fills, or OPEN, or partially
 * filled below its required size, or in any terminal state the classifier had not enumerated, left
 * `hedgeFailure === null` and the naked SELL was transmitted. The guard now consumes a POSITIVE
 * coverage verdict (`hedgeCoverageGap === null` means "every hedge is PROVEN to cover this SELL"),
 * so the default — no proof — refuses. See hedgeCoverageLedger.ts for the attributed, single-use,
 * attempt-scoped evidence that produces that verdict.
 *
 * SCOPE — ENTRY ONLY. This guard must never be consulted for an EXIT, a PROTECTIVE_CANCEL or an
 * EMERGENCY_RESIDUAL. Those reduce exposure that is already owned, and none of the conditions
 * below is a reason to leave real risk on the book. The callers enforce that by checking
 * `purpose === "ENTRY"` before they ever build these inputs; the type name says ENTRY for the
 * same reason.
 */

/** Where in the entry lifecycle a guard evaluation happened. Provenance, not behaviour. */
export type LiveEntryGuardStage =
  /** Before the four broker requests are even constructed. */
  | "pre_build"
  /** Constructed and admitted, immediately before handing them to the order manager. */
  | "pre_enqueue"
  /** The order manager dequeued this leg and took a concurrency slot. */
  | "dequeue"
  /** The durable CREATED → SUBMITTING intent writes are complete. */
  | "post_persist"
  /** Inside the adapter callback, the last instruction before the HTTP POST. */
  | "pre_post";

/**
 * Why an entry was refused. Distinct codes rather than one string, so status and tests can
 * assert the CAUSE and not a message.
 */
export type LiveEntryGuardRefusal =
  | "not_still_wanted"
  | "entry_disarmed"
  | "live_orders_disarmed"
  | "circuit_open"
  | "entry_not_admissible"
  | "attempt_aborted"
  /**
   * A dependent uncovered SELL was refused because its BUY hedges are NOT PROVEN to cover it.
   *
   * This is the INVERSION of the old `hedge_leg_failed` code. The old code fired only on a
   * NAMED hedge failure (a broker rejection, an ambiguous submit); it stayed silent for a hedge
   * that came back CANCELLED with zero fills, OPEN, partially filled below size, or in any
   * terminal state the classifier had not enumerated — and the naked SELL was then authorised.
   * The new code fires whenever coverage is not POSITIVELY PROVEN, so absent/stale/insufficient
   * evidence blocks the SELL by default. See hedgeCoverageLedger.ts.
   */
  | "hedge_coverage_unproven"

  /**
   * The four legs' books no longer form a coherent snapshot at the FINAL send boundary.
   *
   * The gateway evaluates cross-leg coherence twice before enqueueing, but a leg then waits: it is
   * queued, persisted, parked on the hedge-first barrier and paced by the adapter. Books can
   * deteriorate throughout that window, and per-leg freshness cannot see it — four books can each
   * be young while being young at four DIFFERENT instants. Reproduced on e357b83: dispersion rising
   * from 0 to 1,000ms during pacing under a 500ms limit still transmitted all four legs.
   *
   * EXPOSURE-AWARE. This refusal is only ever raised while the attempt has taken NO exposure, which
   * is the only moment at which refusing is free. Once a leg has POSTed, the policy is to COMPLETE
   * the hedged box and record the degradation: abandoning legs 2-4 would convert a timing blip into
   * a partial entry with a real recovery cost, and the post-fill economics gate already rejects a
   * box that turned out uneconomic. It is never applied to an exit or a protective reduction,
   * because the guard is only ever passed for ENTRY legs.
   */
  | "cross_leg_incoherent";

export interface LiveEntryGuardInputs {
  readonly stage: LiveEntryGuardStage;
  /**
   * The composed ownership + scanner predicate. FALSE covers a lost reservation lease, a
   * withdrawn scanner decision, a closed market and an unhealthy feed — the coordinator and
   * scanner fold all of those into the one callback.
   */
  readonly stillWanted: boolean;
  /** Operator/automatic entry arm. */
  readonly entryEnabled: boolean;
  /** Live-order authorization; the master switch for any broker mutation. */
  readonly liveOrderEntryEnabled: boolean;
  /** The order manager's breaker. */
  readonly circuitClosed: boolean;
  /**
   * The order manager's full ENTRY admission verdict (`canEnter`): session permission, health,
   * reconciliation completeness, open-box and residual limits, crash-recovery quarantine.
   * Supplied only by layers that can see it; `true` from layers that cannot.
   */
  readonly entryAdmissible: boolean;
  /** An attempt-level abort raised by a sibling leg, or null. */
  readonly attemptAborted: string | null;
  /**
   * COVERAGE PERMISSION for a dependent uncovered SELL.
   *
   * `null` is a POSITIVE ASSERTION that every BUY hedge this SELL depends on has PROVEN, ATTRIBUTED
   * coverage of its full required quantity (see hedgeCoverageLedger.ts). A non-null value is the
   * specific reason coverage could not be proven — no evidence yet, a non-terminal order, a
   * zero/partial fill, a contract/side/account/attempt mismatch — and it BLOCKS the SELL.
   *
   * This inverts the previous `hedgeFailure` semantics. It was "null unless a hedge was named as
   * failed", which authorised a naked SELL whenever a hedge failed in an UNNAMED way (CANCELLED
   * zero-fill, etc.). This is "null ONLY WHEN coverage is proven", so unprovable coverage — the
   * default — fails closed.
   *
   * Hedge legs themselves do not depend on coverage, so their callers pass `null` here; only the
   * uncovered SELL legs supply a real coverage verdict.
   */
  readonly hedgeCoverageGap: string | null;

  /**
   * CROSS-LEG COHERENCE at the send boundary, or null when it is not applicable/has not degraded.
   *
   * A non-null value is the specific reason the four books no longer form a usable simultaneous
   * snapshot — receive dispersion, exchange dispersion, a generation split, a per-leg stall. Only
   * the `pre_post` checkpoint supplies one, and only while the attempt holds NO exposure; see
   * `cross_leg_incoherent`. Layers that cannot observe the four books pass `null`, which means
   * "no objection from here", NOT "coherence is proven".
   */
  readonly crossLegCoherenceGap: string | null;
}

export type LiveEntryGuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: LiveEntryGuardRefusal; readonly reason: string };

/**
 * Evaluate the composed entry permission.
 *
 * The checks are ordered MOST FUNDAMENTAL FIRST, so that when several conditions fail at once the
 * reported cause is stable and is the one an operator most needs to see. `stillWanted` leads
 * because ownership loss is the condition that makes every later POST actively unsafe rather
 * than merely unwanted.
 */
export function evaluateLiveEntryGuard(inputs: LiveEntryGuardInputs): LiveEntryGuardDecision {
  const at = `at ${inputs.stage}`;
  if (!inputs.stillWanted) {
    return refuse(
      "not_still_wanted",
      `entry is no longer wanted ${at}: ownership/lease lost, or the scanner decision was withdrawn`,
    );
  }
  if (!inputs.liveOrderEntryEnabled) {
    return refuse("live_orders_disarmed", `live order authorization was withdrawn ${at}`);
  }
  if (!inputs.entryEnabled) {
    return refuse("entry_disarmed", `entry was disarmed ${at}`);
  }
  if (!inputs.circuitClosed) {
    return refuse("circuit_open", `the execution circuit breaker is open ${at}`);
  }
  if (inputs.attemptAborted !== null) {
    return refuse("attempt_aborted", `the entry attempt was aborted by a sibling leg ${at}: ${inputs.attemptAborted}`);
  }
  if (inputs.hedgeCoverageGap !== null) {
    return refuse(
      "hedge_coverage_unproven",
      `a dependent SELL was refused ${at} because its BUY hedge coverage is not proven: ${inputs.hedgeCoverageGap}`,
    );
  }
  if (inputs.crossLegCoherenceGap !== null) {
    return refuse(
      "cross_leg_incoherent",
      `the four legs no longer form a coherent snapshot ${at}: ${inputs.crossLegCoherenceGap}`,
    );
  }
  if (!inputs.entryAdmissible) {
    return refuse("entry_not_admissible", `order-manager entry admission closed ${at}`);
  }
  return { allowed: true };
}

function refuse(refusal: LiveEntryGuardRefusal, reason: string): LiveEntryGuardDecision {
  return { allowed: false, refusal, reason };
}

/**
 * Call a caller-supplied predicate without letting it decide by throwing.
 *
 * A predicate that throws has told us nothing, and "nothing" is not permission. Returns false on
 * any throw, so a bug in a scanner or coordinator callback can only ever PREVENT an entry.
 */
export function stillWantedSafely(predicate: (() => boolean) | undefined): boolean {
  if (predicate === undefined) return true;
  try {
    return predicate() === true;
  } catch {
    return false;
  }
}
