/**
 * THE ONE AUTHORITATIVE READINESS DECISION — SECTION 7.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Readiness was being ANSWERED IN THREE PLACES, and the three did not agree:
 *
 *   1. `engine.getStatus()` published two transports (`market_data_state`, `order_stream`) as raw
 *      states and left the reader to combine them.
 *   2. `GET /api/runtime/status` computed `live_entry.blocked` from a DIFFERENT set of facts
 *      (env gates, PostgreSQL, token state, reconciliation) that did not include either transport
 *      lifecycle at all — so it could report entry unblocked while the engine was refusing every
 *      entry because the feed was DEGRADED.
 *   3. The frontend then derived its OWN entry verdict from market-data readiness plus a single
 *      reconcile flag — a third matrix, missing most of the real blockers.
 *
 * Three answers to one question is not redundancy, it is a guarantee that at least two of them are
 * wrong at any moment. This module is the single place the question is answered. Both HTTP surfaces
 * are projections of THIS decision, and the frontend renders it rather than recomputing it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT INVENT A PERMISSION MODEL
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Entry and exposure-management permissions come from {@link combinedPermissions} in
 * `streamHealthPolicy.ts` — the SAME table the live-entry checkpoint consults via
 * {@link entryPermittedFromStreams}. If this module disagreed with that table, the frontend would
 * be shown a permission the engine does not enforce. A test cross-checks every state pair.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ASYMMETRY IT PRESERVES (the load-bearing invariant)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ENTRY-scoped restrictions — a stopped scanner, entry disabled, a spent session budget, an entry
 * capital cap, one-active-underlying, an unavailable reservation service, entry-only market-data
 * requirements, an UNRELATED symbol's stale book — must NEVER independently block a REDUCTION of
 * exposure already owned. Every blocker therefore carries an explicit `scope`, and reduction is
 * computed from the reduction-scoped facts ONLY. Reduction keeps its own genuine requirements: an
 * expired session, or a book it cannot price, still refuses it — and says so.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * NO SECRETS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The account identity is MASKED here and nowhere else, so there is one rule for it. No token, no
 * passcode, no full account id, no credential-bearing URL can pass through this shape: it is a
 * closed set of states, counts, ages, booleans and bounded sentences.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. It does not promise a fill, four-leg atomicity, uninterrupted
 * data, or a bounded loss. `entry.permitted` means "every precondition this system can actually
 * observe is currently satisfied" — never "this trade will work".
 *
 * PURE: no clock (the instant is passed in), no I/O, no globals. Total over its inputs.
 */

import {
  combinedPermissions,
  type MarketDataState,
  type OperationPermissions,
  type OrderStreamLifecycleState,
} from "./streamHealthPolicy.js";
import type { FillObservationMechanism, OrderStreamWiring } from "./orderStreamStatus.js";
import type { OrderStreamState } from "./orderUpdateProjection.js";
import type { BrokerId } from "./latencyModel.js";

/**
 * The version of THIS decision shape.
 *
 * Published in every response so a frontend can tell whether it is reading a decision it
 * understands. Bumped with the wire contract; a frontend that does not recognise it must degrade to
 * "unknown", never to a green light.
 */
export const OPERATIONAL_READINESS_VERSION = "1.6.0";

/* ─────────────────────────── blockers: scope is the whole point ─────────────────────────── */

/**
 * What a blocker is allowed to stop.
 *
 *   entry      — creating NEW exposure only. NEVER touches reduction. This is the scope that holds
 *                the invariant: a stopped scanner or a spent budget is an entry-only fact.
 *   reduction  — genuinely prevents REDUCING exposure (an expired session; no priceable book).
 *                Rare and serious: a reduction blocker means a live position cannot be closed
 *                right now, which is the worst state the system can report.
 *   both       — a fact that really does stop everything (an expired session stops both).
 */
export type BlockerScope = "entry" | "reduction" | "both";

/** One named, operator-readable reason something is not permitted. Never a stack, never a secret. */
export interface ReadinessBlocker {
  /** Stable machine code, for the UI to key and group on. snake_case. */
  readonly code: string;
  /** What this blocker is allowed to stop. */
  readonly scope: BlockerScope;
  /** One bounded sentence a human can act on. */
  readonly detail: string;
}

/** A blocker as published: identical shape, but frozen into the response. */
export interface PublishedBlocker {
  readonly code: string;
  readonly scope: BlockerScope;
  readonly detail: string;
}

/* ─────────────────────────── inputs ─────────────────────────── */

export interface ReadinessIdentityInput {
  readonly broker: BrokerId | null;
  /** The raw trading account id. MASKED before publication; never emitted verbatim. */
  readonly account: string | null;
  readonly executionMode: string;
  /** Whether the live runtime controls are armed right now. */
  readonly liveRuntimeArmed: boolean;
  /** Whether this deployment is capable of live trading at all (env gates). */
  readonly deploymentLiveCapable: boolean;
}

export interface ReadinessMarketDataInput {
  readonly state: MarketDataState;
  /** Connection generation. A book observed under a superseded socket is not evidence. */
  readonly generation: number;
  readonly desiredInstruments: number;
  readonly readyInstruments: number;
  readonly lastFrameAt: number | null;
  readonly lastHeartbeatAt: number | null;
  readonly lastDepthAt: number | null;
  readonly backlog: boolean;
}

export interface ReadinessOrderStreamInput {
  /** The AUTHORITATIVE lifecycle — the value the entry gate scores. */
  readonly lifecycle: OrderStreamLifecycleState;
  /** The state as published in `order_stream`, derived from the lifecycle. */
  readonly publishedState: OrderStreamState;
  readonly wiring: OrderStreamWiring;
  readonly gateEnabled: boolean;
  readonly connected: boolean;
  readonly authorised: boolean;
  readonly lastEventAt: number | null;
  readonly disconnects: number;
  readonly reconcilePending: boolean;
  readonly fillsObservedBy: FillObservationMechanism;
}

export interface ReadinessExposureInput {
  readonly openPositions: number;
  readonly residualLegs: number;
  readonly workingOrders: number;
}

export interface OperationalReadinessInput {
  /** The instant this decision was evaluated. Passed in so the module stays pure. */
  readonly now: number;
  /** Monotonic counter, incremented once per decision, so a stale response is detectable. */
  readonly decisionGeneration: number;
  readonly identity: ReadinessIdentityInput;
  readonly marketData: ReadinessMarketDataInput;
  readonly orderStream: ReadinessOrderStreamInput;
  /**
   * Everything OUTSIDE the two transports that legitimately blocks something: env gates, PostgreSQL,
   * token state, session budget, scanner state, reservations, recovery. Each carries its scope, so
   * an entry-only fact can never leak into the reduction answer.
   */
  readonly blockers: readonly ReadinessBlocker[];
  readonly openExposure: ReadinessExposureInput;
}

/* ─────────────────────────── the published decision ─────────────────────────── */

export interface OperationalReadinessDecision {
  /** Monotonic per-response counter. A response with a LOWER value is stale — ignore it. */
  readonly decision_generation: number;
  /** The shape version, so an unfamiliar frontend degrades to "unknown", never to green. */
  readonly decision_version: string;
  /** When this decision was evaluated (wall ms). */
  readonly decided_at: number;

  readonly identity: {
    readonly broker: BrokerId | null;
    /** MASKED account id, e.g. "AB••34". Never the raw value. Null when no account is bound. */
    readonly account_masked: string | null;
    /** Whether an account is bound at all — distinct from "the id is hidden". */
    readonly account_present: boolean;
    readonly execution_mode: string;
    readonly live_runtime_armed: boolean;
    readonly deployment_live_capable: boolean;
  };

  readonly market_data: {
    readonly state: MarketDataState;
    readonly generation: number;
    readonly desired_instruments: number;
    readonly ready_instruments: number;
    readonly backlog: boolean;
    /** True ONLY in READY: fresh usable depth per traded instrument, this generation. */
    readonly usable_for_entry: boolean;
  };

  readonly order_stream: {
    /** The AUTHORITATIVE lifecycle the entry gate scored. */
    readonly lifecycle: OrderStreamLifecycleState;
    /** The same fact as published in `order_stream`, derived from the lifecycle above. */
    readonly published_state: OrderStreamState;
    readonly wiring: OrderStreamWiring;
    readonly gate_enabled: boolean;
    readonly connected: boolean;
    readonly authorised: boolean;
    readonly disconnects: number;
  };

  /** The mechanism ACTUALLY responsible for observing a fill right now. */
  readonly fill_observation: {
    readonly mechanism: FillObservationMechanism;
    /** True when a broker push is currently doing the observing; false ⇒ REST polling is. */
    readonly stream_assisted: boolean;
    readonly detail: string;
  };

  /** How old the evidence behind this decision is. `null` means NEVER OBSERVED — not fresh. */
  readonly evidence: {
    readonly market_data_frame_age_ms: number | null;
    readonly market_data_heartbeat_age_ms: number | null;
    readonly market_data_depth_age_ms: number | null;
    readonly order_stream_event_age_ms: number | null;
  };

  readonly reconciliation: {
    readonly pending: boolean;
    /** Named reasons a reconciliation is owed or incomplete. Empty when nothing is owed. */
    readonly blockers: readonly PublishedBlocker[];
  };

  /** NEW ENTRY: the single verdict, with every reason it was refused. */
  readonly entry: {
    readonly permitted: boolean;
    readonly reasons: readonly PublishedBlocker[];
  };

  /**
   * EXPOSURE MANAGEMENT — and its REAL limitations, stated rather than implied.
   *
   * Computed from reduction-scoped facts only. An entry-scoped blocker can never appear here.
   */
  readonly exposure_management: {
    readonly exit_and_reduce: boolean;
    readonly protective_cancel: boolean;
    readonly manage_working_orders: boolean;
    /** Reasons a REDUCTION is refused. Empty when reduction is permitted. */
    readonly blocked_reasons: readonly PublishedBlocker[];
    /** What reduction cannot promise even when permitted. Always non-empty — these never go away. */
    readonly limitations: readonly string[];
    readonly open_positions: number;
    readonly residual_legs: number;
    readonly working_orders: number;
  };
}

/* ─────────────────────────── masking ─────────────────────────── */

/**
 * MASK a broker account id for publication.
 *
 * Keeps the first two and last two characters so an operator can confirm WHICH account is bound
 * without the value being reusable or loggable in full. Anything too short to mask safely is
 * reported as fully masked rather than partially leaked — a short id is not a licence to publish it.
 * Returns null for an absent account, which the caller reports as `account_present: false`.
 */
export function maskAccountId(account: string | null | undefined): string | null {
  if (account === null || account === undefined) return null;
  const trimmed = String(account).trim();
  if (trimmed === "") return null;
  if (trimmed.length <= 4) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}••${trimmed.slice(-2)}`;
}

/* ─────────────────────────── the builder ─────────────────────────── */

/** Age of an observation, or null when it was never observed. NEVER 0 for "never". */
function ageOf(now: number, at: number | null): number | null {
  if (at === null || !Number.isFinite(at)) return null;
  return Math.max(0, now - at);
}

/** Reasons a market-data state does not license NEW ENTRY, named per state. */
function marketDataEntryBlocker(state: MarketDataState): ReadinessBlocker | null {
  switch (state) {
    case "READY":
      return null;
    case "DISABLED":
      return {
        code: "market_data_not_configured",
        scope: "both",
        detail: "Market data is not armed, so there is no pricing basis for any decision.",
      };
    case "CONNECTING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail: "Market data is connecting; a route to the broker is not readiness.",
      };
    case "AUTHENTICATING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail: "The market-data socket is open but the session handshake is not yet accepted.",
      };
    case "SYNCHRONIZING":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail:
          "Market data is synchronizing: subscriptions are restoring and fresh depth per traded " +
          "instrument is still owed. Exit and cancel continue.",
      };
    case "DEGRADED":
      return {
        code: "market_data_lifecycle",
        scope: "entry",
        detail:
          "Market data is connected but cannot be trusted for entry (heartbeat gap, stale book, " +
          "partial subscription or an ingestion backlog). A reduction can still be priced off a " +
          "current single-leg book.",
      };
    case "DISCONNECTED":
      return {
        code: "market_data_disconnected",
        scope: "entry",
        detail:
          "The market-data socket is closed or half-open. New entry is stopped; protective cancel " +
          "and exposure management continue.",
      };
    case "AUTH_EXPIRED":
      return {
        code: "market_data_session_expired",
        scope: "both",
        detail:
          "The market-data session or token was rejected or expired. The broker will refuse " +
          "everything but a cancel, so a priced reduction cannot be relied on until it is renewed.",
      };
  }
}

/** Reasons an order-stream lifecycle does not license NEW ENTRY, named per state. */
function orderStreamEntryBlocker(lifecycle: OrderStreamLifecycleState): ReadinessBlocker | null {
  switch (lifecycle) {
    // A DISABLED order stream is NOT a fault: REST polling is the documented baseline and the
    // stream is off by default. It never blocks entry — it only makes fill observation slower.
    case "DISABLED":
    case "READY":
      return null;
    case "CONNECTING":
    case "AUTHENTICATING":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          `The order-update stream is ${lifecycle}: it is not yet delivering, so a fill would be ` +
          `observed only by REST polling. New entry waits; exit and cancel continue.`,
      };
    case "RECONCILING":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream connected and a REST reconciliation is owed. Taking new exposure " +
          "on top of an unrepaired fill gap is how one unknown becomes two.",
      };
    case "DEGRADED":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream is connected but NOT delivering while a fill is expected. Events " +
          "may be missing — which is never read as a zero fill. REST polling is observing fills.",
      };
    case "DISCONNECTED":
      return {
        code: "order_stream_lifecycle",
        scope: "entry",
        detail:
          "The order-update stream is down. REST polling remains the source of truth for fills; " +
          "new entry stops while exposure management continues.",
      };
    case "AUTH_EXPIRED":
      return {
        code: "order_stream_session_expired",
        scope: "entry",
        detail:
          "The session behind the order-update stream was rejected or expired. Reconnecting with it " +
          "is pointless until it is renewed.",
      };
  }
}

/**
 * The limitations of exposure management that are ALWAYS true, permitted or not.
 *
 * Stated explicitly because a green "you can exit" invites the inference that exiting is assured,
 * and it is not: an exit is four more orders into the same market, with the same partial-fill and
 * liquidity risk as the entry. Nothing here is a promise.
 */
const EXPOSURE_LIMITATIONS: readonly string[] = Object.freeze([
  "A reduction is itself an order into the market: it can partially fill, be rejected, or fill at a worse price. Permission is not a fill.",
  "Four-leg atomicity is not available from any broker; legs are reduced one order at a time and an intermediate state is unavoidable.",
  "A reduction needs a usable book for the leg being reduced. Whole-feed readiness is not required, but an unpriceable leg cannot be reduced on a limit price.",
  "Protective cancellation reduces exposure and is permitted in every state except an expired session, where the broker itself refuses.",
]);

/**
 * BUILD THE DECISION.
 *
 * The order of work matters and is deliberate:
 *   1. Score BOTH transports through the shared permission table — the same call the live-entry
 *      checkpoint makes. This is what stops a second matrix existing.
 *   2. Collect ENTRY reasons: transport reasons plus every caller-supplied blocker scoped to entry
 *      (or both). Entry is permitted only when the table says so AND no entry-scoped blocker exists.
 *   3. Collect REDUCTION reasons from reduction-scoped facts ONLY — the invariant. An entry-scoped
 *      blocker is structurally unable to reach this list.
 */
export function buildOperationalReadiness(
  input: OperationalReadinessInput,
): OperationalReadinessDecision {
  const { now, marketData, orderStream, identity, openExposure } = input;

  // (1) The SHARED table — never a local re-derivation.
  const permissions: OperationPermissions = combinedPermissions({
    marketData: marketData.state,
    orderStream: orderStream.lifecycle,
  });

  // (2) ENTRY reasons. Transport reasons first (they explain the table's verdict), then external.
  const entryReasons: PublishedBlocker[] = [];
  const mdBlocker = marketDataEntryBlocker(marketData.state);
  if (mdBlocker) entryReasons.push(mdBlocker);
  const osBlocker = orderStreamEntryBlocker(orderStream.lifecycle);
  if (osBlocker) entryReasons.push(osBlocker);
  for (const b of input.blockers) {
    if (b.scope === "entry" || b.scope === "both") entryReasons.push(b);
  }

  // (3) REDUCTION reasons — reduction-scoped facts ONLY. This is the invariant, enforced by
  // construction rather than by remembering to check: an `entry`-scoped blocker cannot be selected
  // by this filter, so no entry restriction can ever reach the reduction verdict.
  const reductionReasons: PublishedBlocker[] = [];
  if (!permissions.exitAndReduce) {
    // The table refused reduction. Name the transport responsible, from the reduction-relevant
    // states only (an entry-only demotion like SYNCHRONIZING never lands here, because the table
    // permits exitAndReduce there).
    if (marketData.state === "AUTH_EXPIRED") {
      reductionReasons.push({
        code: "market_data_session_expired",
        scope: "reduction",
        detail:
          "The session or token was rejected or expired: the broker will refuse a priced reduction. " +
          "A protective cancel is the only action it will still accept.",
      });
    } else if (marketData.state === "DISABLED") {
      reductionReasons.push({
        code: "market_data_not_configured",
        scope: "reduction",
        detail: "Market data is not armed, so a reduction cannot be priced at all.",
      });
    } else if (marketData.state === "DISCONNECTED") {
      reductionReasons.push({
        code: "market_data_disconnected",
        scope: "reduction",
        detail:
          "The market-data socket is closed, so no current book exists to price a reduction against. " +
          "Protective cancellation still reduces exposure and remains permitted.",
      });
    } else if (marketData.state === "CONNECTING" || marketData.state === "AUTHENTICATING") {
      reductionReasons.push({
        code: "market_data_lifecycle",
        scope: "reduction",
        detail:
          `Market data is ${marketData.state}: there is no current book to price a reduction ` +
          `against yet. Protective cancellation remains permitted.`,
      });
    } else if (marketData.state === "SYNCHRONIZING") {
      reductionReasons.push({
        code: "market_data_lifecycle",
        scope: "reduction",
        detail:
          "Market data is synchronizing after a reconnect and no book in the current generation is " +
          "proven yet. Protective cancellation remains permitted.",
      });
    } else if (orderStream.lifecycle === "AUTH_EXPIRED") {
      reductionReasons.push({
        code: "order_stream_session_expired",
        scope: "reduction",
        detail:
          "The session behind the order-update stream was rejected or expired, so a reduction " +
          "cannot be confirmed. A protective cancel is still accepted.",
      });
    }
  }
  for (const b of input.blockers) {
    if (b.scope === "reduction" || b.scope === "both") reductionReasons.push(b);
  }

  // Reconciliation blockers: what is owed, and anything the caller flagged as recovery work.
  const reconciliationBlockers: PublishedBlocker[] = [];
  if (orderStream.reconcilePending) {
    reconciliationBlockers.push({
      code: "order_stream_reconciliation_owed",
      scope: "entry",
      detail:
        "A REST reconciliation of the order-update gap is owed. Events in the gap are NOT assumed " +
        "absent; they are repaired from REST before the stream is trusted again.",
    });
  }
  for (const b of input.blockers) {
    if (b.code.includes("reconcil") || b.code.includes("recovery")) {
      reconciliationBlockers.push(b);
    }
  }

  const streamAssisted = orderStream.fillsObservedBy === "stream_primary_rest_reconcile";

  return {
    decision_generation: input.decisionGeneration,
    decision_version: OPERATIONAL_READINESS_VERSION,
    decided_at: now,

    identity: {
      broker: identity.broker,
      account_masked: maskAccountId(identity.account),
      account_present: maskAccountId(identity.account) !== null,
      execution_mode: identity.executionMode,
      live_runtime_armed: identity.liveRuntimeArmed,
      deployment_live_capable: identity.deploymentLiveCapable,
    },

    market_data: {
      state: marketData.state,
      generation: marketData.generation,
      desired_instruments: marketData.desiredInstruments,
      ready_instruments: marketData.readyInstruments,
      backlog: marketData.backlog,
      usable_for_entry: marketData.state === "READY",
    },

    order_stream: {
      lifecycle: orderStream.lifecycle,
      published_state: orderStream.publishedState,
      wiring: orderStream.wiring,
      gate_enabled: orderStream.gateEnabled,
      connected: orderStream.connected,
      authorised: orderStream.authorised,
      disconnects: orderStream.disconnects,
    },

    fill_observation: {
      mechanism: orderStream.fillsObservedBy,
      stream_assisted: streamAssisted,
      detail: streamAssisted
        ? "A broker push is observing fills first; REST reconciles behind it."
        : "REST polling is observing fills. Fill-observation latency is bounded by the polling " +
          "cadence and the pacing floor, not by broker push latency.",
    },

    evidence: {
      market_data_frame_age_ms: ageOf(now, marketData.lastFrameAt),
      market_data_heartbeat_age_ms: ageOf(now, marketData.lastHeartbeatAt),
      market_data_depth_age_ms: ageOf(now, marketData.lastDepthAt),
      order_stream_event_age_ms: ageOf(now, orderStream.lastEventAt),
    },

    reconciliation: {
      pending: orderStream.reconcilePending,
      blockers: reconciliationBlockers,
    },

    entry: {
      // BOTH conditions: the shared table AND the absence of any entry-scoped external blocker.
      permitted: permissions.newEntry && entryReasons.length === 0,
      reasons: entryReasons,
    },

    exposure_management: {
      // Reduction is scored from the table plus reduction-scoped blockers ONLY.
      exit_and_reduce: permissions.exitAndReduce && reductionReasons.length === 0,
      protective_cancel: permissions.protectiveCancel,
      manage_working_orders: permissions.manageWorkingOrders,
      blocked_reasons: reductionReasons,
      limitations: EXPOSURE_LIMITATIONS,
      open_positions: openExposure.openPositions,
      residual_legs: openExposure.residualLegs,
      working_orders: openExposure.workingOrders,
    },
  };
}
