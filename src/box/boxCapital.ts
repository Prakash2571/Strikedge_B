/**
 * MAXIMUM ₹ EXPOSURE PER BOX — the admission metric and its gate.
 *
 * WHAT THIS NUMBER IS
 *
 * `gross_entry_order_notional_rupees` = SUM over the four ENTRY legs of
 *
 *     |limit_price x quantity|
 *
 * computed from the ACTUAL bounded LIMIT order requests that would be transmitted. It is
 * the largest rupee amount those four immutable orders can transact, because a LIMIT order
 * can never fill worse than its limit and the Box never uses MARKET orders.
 *
 * WHAT THIS NUMBER IS **NOT**
 *
 * It is NOT broker margin. It is NOT SPAN+exposure. It is NOT the capital the broker will
 * actually block. A four-leg Box is a hedged structure and its real margin requirement is
 * typically a small fraction of gross option notional — sometimes it is a NET CREDIT. The
 * naming is deliberate and the code must never be edited to call this "margin", because an
 * operator who reads "margin: ₹120,000" and sets a ₹120,000 cap would be setting a limit
 * roughly an order of magnitude away from what they intended.
 *
 * If a reliable broker margin API is available its answer is exposed SEPATATELY as
 * `broker_estimated_margin_rupees` (see {@link BoxCapitalReport}) and is never substituted
 * for the admission metric: one is an observable property of our own bounded orders, the
 * other is a remote estimate that can fail, lag, or be denied.
 *
 * WHY GROSS NOTIONAL IS STILL THE RIGHT ADMISSION GATE
 *
 * It is deterministic, computable offline from data we already hold, monotone in quantity
 * and price, and CONSERVATIVE (it always over-states the economic risk of a hedged Box).
 * An operator using it is expressing "do not let one Box transact more than ₹X of option
 * premium", which is a meaningful, auditable sentence. It requires no broker round trip, so
 * it can be evaluated at the last safe moment before submission — which a remote margin
 * call cannot.
 *
 * PRECISION
 *
 * All comparisons are done in INTEGER PAISE. Rupee floats cannot represent ₹0.01 exactly,
 * and the specification requires that ₹0.01 over the cap is refused while exactly at the
 * cap is admitted. Comparing paise integers makes that boundary exact rather than
 * dependent on IEEE-754 rounding.
 */

import type { BoxLegRole, OrderSide } from "./types.js";

/** ₹ -> integer paise, half-up. Total: non-finite input yields 0. */
export function toPaise(rupees: number): number {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * 100);
}

/** Integer paise -> ₹, to 2dp. */
export function fromPaise(paise: number): number {
  if (!Number.isFinite(paise)) return 0;
  return Math.round(paise) / 100;
}

/** The minimal shape of an order request this module needs. */
export interface BoxCapitalOrderLike {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  readonly pricing: { readonly limit_price: number };
}

/** One leg's contribution to the gross entry notional. */
export interface BoxCapitalLegBreakdown {
  readonly role: BoxLegRole;
  readonly side: OrderSide;
  readonly tradingsymbol: string;
  readonly quantity: number;
  /** The bounded LIMIT price used — never an LTP, never a mid. */
  readonly limit_price: number;
  readonly notional_rupees: number;
}

/**
 * The computed metric, plus whether it is TRUSTWORTHY.
 *
 * `complete` is the safety-critical field. A metric computed from three priced legs and one
 * unpriced leg understates the true total, and admitting on an understated total is exactly
 * how a cap gets bypassed. Callers must treat `complete === false` as "cannot prove
 * compliance" and refuse when a cap is configured.
 */
export interface BoxCapitalMetrics {
  readonly gross_entry_order_notional_rupees: number;
  readonly gross_entry_order_notional_paise: number;
  readonly legs: readonly BoxCapitalLegBreakdown[];
  readonly leg_count: number;
  /** True only when every leg carried a finite, positive quantity and limit price. */
  readonly complete: boolean;
  /** Human-readable reason `complete` is false, else null. */
  readonly incomplete_reason: string | null;
}

/**
 * Compute the gross entry-order notional from the bounded LIMIT requests.
 *
 * `expectedLegCount` defaults to 4 (a Box). Passing the count explicitly lets the caller
 * assert "I built four requests" so a silently-dropped leg is caught here rather than
 * becoming an under-stated total.
 */
export function grossEntryOrderNotional(
  requests: readonly BoxCapitalOrderLike[],
  expectedLegCount = 4,
): BoxCapitalMetrics {
  const legs: BoxCapitalLegBreakdown[] = [];
  const problems: string[] = [];
  let totalPaise = 0;

  for (const request of requests) {
    const quantity = request.quantity;
    const limit = request.pricing?.limit_price;
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
      problems.push(`${request.role} has a non-positive or non-integer quantity (${String(quantity)})`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      problems.push(`${request.role} has no usable bounded LIMIT price (${String(limit)})`);
      continue;
    }
    // Absolute value: a Box mixes BUY and SELL legs, and the metric is GROSS transacted
    // value, not a net debit. Netting BUY against SELL would let an arbitrarily large Box
    // through by pairing offsetting legs — the exact opposite of a conservative cap.
    const legPaise = Math.abs(toPaise(limit) * quantity);
    totalPaise += legPaise;
    legs.push({
      role: request.role,
      side: request.side,
      tradingsymbol: request.tradingsymbol,
      quantity,
      limit_price: limit,
      notional_rupees: fromPaise(legPaise),
    });
  }

  if (legs.length !== expectedLegCount) {
    problems.push(`expected ${expectedLegCount} priced legs, computed ${legs.length}`);
  }

  return {
    gross_entry_order_notional_rupees: fromPaise(totalPaise),
    gross_entry_order_notional_paise: totalPaise,
    legs,
    leg_count: legs.length,
    complete: problems.length === 0,
    incomplete_reason: problems.length === 0 ? null : problems.join("; "),
  };
}

/** Where in the pipeline a capital check ran. Recorded so a refusal is attributable. */
export type BoxCapitalCheckStage =
  /** During candidate qualification, for visibility. Advisory only. */
  | "qualification"
  /** From the immutable bounded order requests, immediately before durable submission. */
  | "pre_submit"
  /** Re-checked at dequeue, because requests may have been rebuilt or prices re-read. */
  | "dequeue";

/** The refusal reason string persisted and reported for a capital-cap block. */
export const BOX_CAPITAL_LIMIT_REASON = "box_capital_limit" as const;

export interface BoxCapitalReport {
  readonly stage: BoxCapitalCheckStage;
  /** Whether a cap is configured at all. `false` ⇒ this gate is disabled. */
  readonly enabled: boolean;
  readonly allowed: boolean;
  /** `box_capital_limit` when refused, else null. */
  readonly reason: typeof BOX_CAPITAL_LIMIT_REASON | null;
  readonly detail: string | null;
  readonly calculated_rupees: number;
  readonly configured_max_rupees: number;
  readonly broker: string;
  /** The Box candidate key. Internal identifier; not a secret, but not surfaced to end users. */
  readonly candidate_key: string;
  readonly at: number;
  readonly metrics: BoxCapitalMetrics;
  /**
   * A broker's own margin estimate, when one was obtained. NEVER used for admission and
   * NEVER substituted for `calculated_rupees`. Null when unavailable, which is the common
   * case and must not be mistaken for zero.
   */
  readonly broker_estimated_margin_rupees: number | null;
}

/**
 * Evaluate the configured ₹ cap against a computed metric.
 *
 * SEMANTICS, pinned by tests:
 *   - `limitRupees <= 0` ⇒ the gate is DISABLED and everything is admitted. This is the
 *     default, so an existing deployment upgrading to this build changes behaviour in no
 *     way whatsoever.
 *   - amount strictly below the cap ⇒ admitted.
 *   - amount EXACTLY at the cap ⇒ admitted (the cap is a maximum, inclusive).
 *   - amount ₹0.01 over the cap ⇒ refused.
 *   - metric NOT `complete` while a cap is configured ⇒ REFUSED. We cannot prove
 *     compliance from an under-stated total, and an unprovable safety gate is not a
 *     safety gate.
 *
 * This function is pure and performs no submission. Refusing here is a PRE-TRADE refusal:
 * the caller must invoke it before any broker mutation.
 */
export function evaluateBoxCapitalAdmission(args: {
  readonly metrics: BoxCapitalMetrics;
  readonly limitRupees: number;
  readonly broker: string;
  readonly candidateKey: string;
  readonly at: number;
  readonly stage: BoxCapitalCheckStage;
  readonly brokerEstimatedMarginRupees?: number | null;
}): BoxCapitalReport {
  const limit = Number.isFinite(args.limitRupees) ? args.limitRupees : 0;
  const base = {
    stage: args.stage,
    calculated_rupees: args.metrics.gross_entry_order_notional_rupees,
    configured_max_rupees: limit > 0 ? limit : 0,
    broker: args.broker,
    candidate_key: args.candidateKey,
    at: args.at,
    metrics: args.metrics,
    broker_estimated_margin_rupees: args.brokerEstimatedMarginRupees ?? null,
  } as const;

  if (limit <= 0) {
    // Disabled. Deliberately does NOT inspect `complete`: with no cap configured there is
    // nothing to prove, and refusing an entry because a metric we are not using is
    // incomplete would be a behaviour regression for every existing deployment.
    return { ...base, enabled: false, allowed: true, reason: null, detail: null };
  }

  if (!args.metrics.complete) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `cannot verify the ₹${limit} per-Box cap: ${args.metrics.incomplete_reason ?? "metric incomplete"}. ` +
        "Refusing rather than admitting on an under-stated total.",
    };
  }

  const limitPaise = toPaise(limit);
  if (args.metrics.gross_entry_order_notional_paise > limitPaise) {
    return {
      ...base,
      enabled: true,
      allowed: false,
      reason: BOX_CAPITAL_LIMIT_REASON,
      detail:
        `gross_entry_order_notional_rupees ₹${args.metrics.gross_entry_order_notional_rupees} exceeds the ` +
        `configured BOX_LIVE_MAX_BOX_CAPITAL_RUPEES ₹${limit} (checked at ${args.stage}). ` +
        "This is gross option-order notional from the bounded LIMIT requests, NOT broker margin.",
    };
  }

  return { ...base, enabled: true, allowed: true, reason: null, detail: null };
}

/**
 * A compact, low-cardinality projection for status/diagnostics.
 *
 * Deliberately omits the per-leg breakdown and the candidate key: a status endpoint polled
 * every second must not grow unbounded, and per-leg tradingsymbols are high-cardinality
 * labels of the kind the metrics contract already forbids.
 */
export function boxCapitalSummary(report: BoxCapitalReport | null): {
  enabled: boolean;
  configured_max_rupees: number;
  last_calculated_rupees: number | null;
  last_stage: BoxCapitalCheckStage | null;
  last_allowed: boolean | null;
  last_at: number | null;
} {
  if (!report) {
    return {
      enabled: false,
      configured_max_rupees: 0,
      last_calculated_rupees: null,
      last_stage: null,
      last_allowed: null,
      last_at: null,
    };
  }
  return {
    enabled: report.enabled,
    configured_max_rupees: report.configured_max_rupees,
    last_calculated_rupees: report.calculated_rupees,
    last_stage: report.stage,
    last_allowed: report.allowed,
    last_at: report.at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE FIVE DISTINCT ECONOMIC QUANTITIES  (Task 9)
//
// The gross-notional metric above is ONE of five quantities an honest admission gate must keep
// separate. Conflating any two of them is how a box is admitted that the broker will reject, or
// that will breach available funds during the legging window even though the final hedged
// position is cheap. The five, never to be substituted for one another:
//
//   1. AVAILABLE broker funds            — what the account can actually deploy right now.
//   2. Margin required by the PLANNED     — the broker's own estimate for the four-leg basket,
//      execution sequence                   from a SUPPORTED margin facility (Kite basket /
//                                            Dhan multi). An ESTIMATE, never a guarantee of
//                                            acceptance.
//   3. PEAK TEMPORARY EXPOSURE            — the most capital tied up at any instant DURING
//      (the legging window)                 legging, before all four legs and their hedge
//                                            benefit exist. Can far exceed (2).
//   4. GROSS order notional              — the existing metric above. Deterministic, offline,
//                                            conservative. Keeps its label.
//   5. Bounded WORST-CASE entry prices   — the largest the four LIMIT orders can cost, and the
//      and estimated costs                  estimated charges on top. Deterministic from the
//                                            bounded requests.
//
// PROVENANCE is a first-class type here. Every remote figure is tagged with where it came from,
// when, and whether it is a broker-CONFIRMED value or our own ESTIMATE. A stale or failed fetch
// yields an explicit `unavailable`/`stale` status that the gate treats as "cannot prove", never
// as an optimistic zero.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Where an economic figure came from, and how much it can be trusted.
 *
 *   "broker_confirmed" — returned by a supported broker margin/funds facility THIS session.
 *   "estimate"         — computed by us (e.g. gross notional, worst-case cost). Deterministic
 *                        but NOT a promise the broker will accept the orders.
 *   "unavailable"      — no figure could be obtained. Distinct from a value of 0.
 *   "stale"            — a figure was obtained but is older than the configured freshness bound.
 */
export type EconomicProvenance = "broker_confirmed" | "estimate" | "unavailable" | "stale";

/**
 * A single economic quantity with full provenance.
 *
 * `value` is null whenever provenance is "unavailable" — null is "not known", never "₹0". A
 * caller must branch on `provenance` before trusting `value`, which the type nudges by making
 * `value` nullable.
 */
export interface EconomicFigure {
  readonly value_rupees: number | null;
  readonly provenance: EconomicProvenance;
  /** Epoch ms the figure was observed, or null when never observed. */
  readonly observed_at: number | null;
  /** Age (ms) at the time the report was built, or null when never observed. */
  readonly age_ms: number | null;
  /** True when provenance is broker_confirmed AND within the freshness bound. */
  readonly usable: boolean;
  /** Free-text describing exactly what this figure can and cannot prove. */
  readonly note: string;
}

/**
 * Build an {@link EconomicFigure} for a REMOTE (broker) figure, applying the freshness bound.
 *
 * A figure older than `maxAgeMs` is downgraded to "stale" and marked unusable, because a margin
 * or funds number that predates the current book cannot be trusted to admit a live entry.
 */
export function brokerFigure(args: {
  readonly valueRupees: number | null;
  readonly observedAt: number | null;
  readonly now: number;
  readonly maxAgeMs: number;
  readonly confirmedNote: string;
}): EconomicFigure {
  if (args.valueRupees === null || !Number.isFinite(args.valueRupees) || args.observedAt === null) {
    return {
      value_rupees: null,
      provenance: "unavailable",
      observed_at: null,
      age_ms: null,
      usable: false,
      note: "no broker figure obtained; treated as UNKNOWN, never as ₹0",
    };
  }
  const age = args.now - args.observedAt;
  const fresh = Number.isFinite(age) && age >= 0 && age <= args.maxAgeMs;
  return {
    value_rupees: args.valueRupees,
    provenance: fresh ? "broker_confirmed" : "stale",
    observed_at: args.observedAt,
    age_ms: Number.isFinite(age) ? age : null,
    usable: fresh,
    note: fresh
      ? args.confirmedNote
      : `broker figure is ${Number.isFinite(age) ? age : "?"}ms old, over the ${args.maxAgeMs}ms ` +
        "freshness bound; treated as STALE and not usable for admission",
  };
}

/** Build an {@link EconomicFigure} for a locally COMPUTED estimate (always fresh, never a guarantee). */
export function estimateFigure(valueRupees: number | null, now: number, note: string): EconomicFigure {
  if (valueRupees === null || !Number.isFinite(valueRupees)) {
    return {
      value_rupees: null,
      provenance: "unavailable",
      observed_at: null,
      age_ms: null,
      usable: false,
      note: "estimate could not be computed (an unpriced leg); treated as UNKNOWN",
    };
  }
  return {
    value_rupees: valueRupees,
    provenance: "estimate",
    observed_at: now,
    age_ms: 0,
    usable: true,
    note: `${note} This is OUR estimate from the bounded requests, NOT a broker-confirmed figure.`,
  };
}

/**
 * The bounded WORST-CASE entry cost of the four legs (quantity #5).
 *
 * For each leg, the worst the LIMIT order can cost the account is |limit_price x quantity| — the
 * same paise the gross-notional metric sums, but here it is a DEBIT view: BUY legs cost money,
 * SELL legs receive premium. We return BOTH the gross (all legs as cost, matching #4) and the
 * NET worst-case debit (buys minus sells), because peak exposure during legging is bounded by
 * the gross while the final settled debit is bounded by the net. Callers must not conflate them.
 */
export interface WorstCaseEntryCost {
  /** Sum of |limit x qty| over all four legs — matches gross notional, the peak-legging bound. */
  readonly gross_cost_rupees: number;
  /** BUY premium paid minus SELL premium received, at the bounded limits — the settled bound. */
  readonly net_debit_rupees: number;
  /** Estimated round-trip charges on top, when a charge estimate is supplied. Null otherwise. */
  readonly estimated_charges_rupees: number | null;
  readonly complete: boolean;
  readonly incomplete_reason: string | null;
}

export function worstCaseEntryCost(
  requests: readonly BoxCapitalOrderLike[],
  estimatedChargesRupees: number | null = null,
): WorstCaseEntryCost {
  const problems: string[] = [];
  let grossPaise = 0;
  let netDebitPaise = 0;
  let priced = 0;
  for (const r of requests) {
    const q = r.quantity;
    const limit = r.pricing?.limit_price;
    if (!Number.isFinite(q) || q <= 0 || !Number.isInteger(q)) {
      problems.push(`${r.role} non-positive/non-integer quantity`);
      continue;
    }
    if (!Number.isFinite(limit) || limit <= 0) {
      problems.push(`${r.role} unpriced`);
      continue;
    }
    const legPaise = Math.abs(toPaise(limit) * q);
    grossPaise += legPaise;
    // A BUY pays premium (positive debit); a SELL receives it (negative debit).
    netDebitPaise += r.side === "BUY" ? legPaise : -legPaise;
    priced++;
  }
  if (priced !== 4) problems.push(`expected 4 priced legs, got ${priced}`);
  return {
    gross_cost_rupees: fromPaise(grossPaise),
    net_debit_rupees: fromPaise(netDebitPaise),
    estimated_charges_rupees:
      estimatedChargesRupees !== null && Number.isFinite(estimatedChargesRupees)
        ? estimatedChargesRupees
        : null,
    complete: problems.length === 0,
    incomplete_reason: problems.length === 0 ? null : problems.join("; "),
  };
}

/**
 * The complete, HONEST economic picture of a candidate box — all five quantities, each with its
 * own provenance, none substituted for another.
 *
 * This is a REPORT, not a gate: {@link evaluateEconomicAdmission} decides admission from it. The
 * separation matters because the report is also what diagnostics display, and an operator must
 * be able to see, for instance, that funds are ample but the margin fetch is stale.
 */
export interface EconomicPicture {
  /** #1 Available broker funds. */
  readonly available_funds: EconomicFigure;
  /** #2 Margin required by the planned execution sequence (broker basket estimate). */
  readonly planned_margin: EconomicFigure;
  /** #3 Peak temporary exposure during the legging window. */
  readonly peak_legging_exposure: EconomicFigure;
  /** #4 Gross order notional — the existing metric, unchanged label. */
  readonly gross_notional: EconomicFigure;
  /** #5 Bounded worst-case entry cost. */
  readonly worst_case_entry: EconomicFigure;
  /** The underlying gross-notional metric object, for the leg breakdown. */
  readonly gross_notional_metrics: BoxCapitalMetrics;
}

/**
 * Assemble the five quantities into one picture.
 *
 * PEAK LEGGING EXPOSURE is derived from the bounded requests, NOT from the broker margin: while
 * legging, before the offsetting legs both exist, the account can be exposed to as much as the
 * gross cost of the legs already sent. We therefore bound #3 by the gross notional (#4) as a
 * conservative upper bound and label it an estimate — the true peak depends on fill order, which
 * the execution-sequence owner (orderManager) knows and this pure module deliberately does not.
 */
export function buildEconomicPicture(args: {
  readonly requests: readonly BoxCapitalOrderLike[];
  readonly now: number;
  readonly marginFreshnessMaxAgeMs: number;
  readonly fundsFreshnessMaxAgeMs: number;
  readonly availableFundsRupees?: number | null;
  readonly availableFundsObservedAt?: number | null;
  readonly plannedMarginRupees?: number | null;
  readonly plannedMarginObservedAt?: number | null;
  readonly estimatedChargesRupees?: number | null;
  readonly expectedLegCount?: number;
}): EconomicPicture {
  const metrics = grossEntryOrderNotional(args.requests, args.expectedLegCount ?? 4);
  const worst = worstCaseEntryCost(args.requests, args.estimatedChargesRupees ?? null);

  return {
    available_funds: brokerFigure({
      valueRupees: args.availableFundsRupees ?? null,
      observedAt: args.availableFundsObservedAt ?? null,
      now: args.now,
      maxAgeMs: args.fundsFreshnessMaxAgeMs,
      confirmedNote: "broker-confirmed available funds for this account/session",
    }),
    planned_margin: brokerFigure({
      valueRupees: args.plannedMarginRupees ?? null,
      observedAt: args.plannedMarginObservedAt ?? null,
      now: args.now,
      maxAgeMs: args.marginFreshnessMaxAgeMs,
      confirmedNote:
        "broker basket-margin estimate for the four-leg sequence (Kite basket / Dhan multi). " +
        "An ESTIMATE of the requirement — it does NOT guarantee the broker will accept the orders.",
    }),
    peak_legging_exposure: estimateFigure(
      metrics.complete ? metrics.gross_entry_order_notional_rupees : null,
      args.now,
      "peak temporary exposure during legging, bounded ABOVE by gross notional; the true peak " +
        "depends on fill order which this pure module does not observe.",
    ),
    gross_notional: estimateFigure(
      metrics.complete ? metrics.gross_entry_order_notional_rupees : null,
      args.now,
      "gross option-order notional from the bounded LIMIT requests (existing metric).",
    ),
    worst_case_entry: estimateFigure(
      worst.complete ? worst.gross_cost_rupees : null,
      args.now,
      "bounded worst-case gross entry cost from the LIMIT requests.",
    ),
    gross_notional_metrics: metrics,
  };
}

/** Why an economic admission was refused. Distinct, non-conflated reasons. */
export type EconomicRefusalReason =
  | "gross_notional_over_cap"
  | "insufficient_available_funds"
  | "margin_evidence_stale_or_missing"
  | "metric_incomplete";

export interface EconomicAdmissionReport {
  readonly allowed: boolean;
  readonly reasons: readonly EconomicRefusalReason[];
  readonly detail: string | null;
  readonly picture: EconomicPicture;
  /** Whether each configured control was ENABLED (a control with no config is skipped). */
  readonly controls: {
    readonly gross_cap_enabled: boolean;
    readonly funds_check_enabled: boolean;
    readonly margin_evidence_required: boolean;
  };
}

/**
 * Evaluate the configured economic controls against the five-quantity picture, BEFORE any leg is
 * sent. Each control is independent and fails CLOSED:
 *
 *   - `grossCapRupees > 0`: refuse if gross notional (#4) exceeds it, or is incomplete. (Same
 *     semantics as {@link evaluateBoxCapitalAdmission}; kept in step deliberately.)
 *   - `requireFundsCover`: refuse unless AVAILABLE FUNDS (#1) are usable AND cover the planned
 *     margin (#2) when that is usable, else the worst-case entry cost (#5). Never admits on a
 *     stale/unavailable funds figure.
 *   - `requireMarginEvidence`: refuse unless the planned-margin figure (#2) is broker-confirmed
 *     and fresh. This is the "do not admit on an estimate alone" control.
 *
 * Returning MULTIPLE reasons is intentional: an operator debugging a refusal should see every
 * failing control at once, not fix one and rediscover the next.
 */
export function evaluateEconomicAdmission(args: {
  readonly picture: EconomicPicture;
  readonly grossCapRupees: number;
  readonly requireFundsCover: boolean;
  readonly requireMarginEvidence: boolean;
}): EconomicAdmissionReport {
  const { picture } = args;
  const reasons: EconomicRefusalReason[] = [];
  const details: string[] = [];

  const grossCapEnabled = Number.isFinite(args.grossCapRupees) && args.grossCapRupees > 0;
  if (grossCapEnabled) {
    if (!picture.gross_notional_metrics.complete) {
      reasons.push("metric_incomplete");
      details.push(
        `cannot verify the ₹${args.grossCapRupees} gross cap: ` +
          `${picture.gross_notional_metrics.incomplete_reason ?? "metric incomplete"}`,
      );
    } else {
      const overCap =
        picture.gross_notional_metrics.gross_entry_order_notional_paise > toPaise(args.grossCapRupees);
      if (overCap) {
        reasons.push("gross_notional_over_cap");
        details.push(
          `gross_entry_order_notional_rupees ₹${picture.gross_notional_metrics.gross_entry_order_notional_rupees} ` +
            `exceeds the configured gross cap ₹${args.grossCapRupees} (gross option-order notional, NOT broker margin)`,
        );
      }
    }
  }

  if (args.requireMarginEvidence && !picture.planned_margin.usable) {
    reasons.push("margin_evidence_stale_or_missing");
    details.push(
      `planned-margin evidence is not usable (${picture.planned_margin.provenance}); ` +
        "refusing rather than admitting on an estimate or a stale figure",
    );
  }

  if (args.requireFundsCover) {
    if (!picture.available_funds.usable || picture.available_funds.value_rupees === null) {
      reasons.push("insufficient_available_funds");
      details.push(
        `available funds not usable (${picture.available_funds.provenance}); ` +
          "cannot prove the account can fund this entry",
      );
    } else {
      // Require funds to cover the strongest requirement we can prove: broker margin if usable,
      // else the conservative worst-case entry cost. NEVER the (smaller) net debit alone.
      const need =
        picture.planned_margin.usable && picture.planned_margin.value_rupees !== null
          ? picture.planned_margin.value_rupees
          : picture.worst_case_entry.value_rupees;
      if (need === null) {
        reasons.push("metric_incomplete");
        details.push("cannot compute a funding requirement: no usable margin or worst-case cost");
      } else if (picture.available_funds.value_rupees < need) {
        reasons.push("insufficient_available_funds");
        details.push(
          `available funds ₹${picture.available_funds.value_rupees} < required ₹${need} ` +
            (picture.planned_margin.usable ? "(broker margin)" : "(worst-case entry cost)"),
        );
      }
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    detail: details.length ? details.join("; ") : null,
    picture,
    controls: {
      gross_cap_enabled: grossCapEnabled,
      funds_check_enabled: args.requireFundsCover,
      margin_evidence_required: args.requireMarginEvidence,
    },
  };
}

/**
 * The recovery/completion policy once a box is PARTIALLY EXPOSED.
 *
 * The task requires that once legs are on the book we stop chasing the ORIGINAL profit threshold
 * and instead complete or unwind on a recovery basis. This is a pure decision helper the
 * execution owner can consult; it does not itself place orders (it cannot — this module owns no
 * transport). It keeps the one-lot rule: it never proposes resizing a partially filled box.
 */
export type RecoveryAction = "complete_remaining_legs" | "unwind_filled_legs" | "hold_and_reassess";

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly reason: string;
  /** Always true here: the policy never resizes a box into a different strategy. */
  readonly one_lot_preserved: true;
}

/**
 * Decide what to do with a partially-exposed box.
 *
 *   - If completing the remaining legs is still feasible within funds/margin evidence, complete
 *     them — a hedged box is cheaper to hold than a naked partial.
 *   - If the remaining legs can no longer be proven affordable, UNWIND the filled legs rather
 *     than chase the original edge: an unhedged partial is the exposure we most want to shed.
 *   - If evidence is merely stale (not disproven), HOLD and reassess when fresh evidence
 *     arrives, rather than act on a stale number.
 */
export function decidePartialRecovery(args: {
  readonly remainingLegsPriceable: boolean;
  readonly completionAffordable: boolean;
  readonly marginEvidenceUsable: boolean;
}): RecoveryDecision {
  if (!args.marginEvidenceUsable) {
    return {
      action: "hold_and_reassess",
      reason:
        "margin/funds evidence is stale or missing; holding a partial and reassessing on fresh " +
        "evidence is safer than acting on an unverified number",
      one_lot_preserved: true,
    };
  }
  if (args.remainingLegsPriceable && args.completionAffordable) {
    return {
      action: "complete_remaining_legs",
      reason: "completing the hedge is affordable; a completed box carries less risk than a naked partial",
      one_lot_preserved: true,
    };
  }
  return {
    action: "unwind_filled_legs",
    reason:
      "the remaining legs cannot be proven affordable/priceable; unwinding the filled legs sheds " +
      "the unhedged exposure rather than chasing the original profit threshold",
    one_lot_preserved: true,
  };
}
