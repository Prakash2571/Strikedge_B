/**
 * ORDER-STREAM CONSUMER — the PRODUCTION component that makes a broker order-update stream
 * actually resolve fills, instead of merely relabelling status.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS / WHAT IT WIRES TOGETHER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Before this, every piece was built and unit-tested but nothing constructed and connected them:
 *
 *   transports          brokers/zerodha/orderUpdates.ts (parseKiteOrderFrame)
 *                       brokers/dhan/orderFeed.ts        (DhanOrderFeed / parseDhanOrderAlert)
 *   ONE truth           box/orderUpdateProjection.ts     (OrderUpdateProjection)
 *   the wake seam       box/{kite,dhan}BrokerAdapter.ts  (applyOrderUpdate → wakes order waiters)
 *   the health machine  box/streamHealthPolicy.ts        (OrderStreamStateMachine + permissions)
 *
 * This class owns ONE {@link OrderUpdateProjection} and ONE {@link OrderStreamStateMachine} per
 * active broker account, and is the single point where a normalized observation — from the stream
 * OR from REST — is (1) attributed and deduplicated through the projection, and (2) handed to the
 * adapter's {@link BrokerAdapter.applyOrderUpdate}, which re-validates the evidence, applies it
 * cumulative-monotonically to the session snapshot, and WAKES that order's waiters. That last step
 * is what makes a stream event resolve a live `waitForResolution` loop BEFORE its REST poll fires.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE RULES THIS CLASS ENFORCES (each maps to the task brief)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  - OWNERSHIP FIRST, BEFORE THE POST. {@link registerIntent} is called as the durable intent
 *    enters SUBMITTING — before the HTTP POST — so an event that beats the placement response has
 *    a ledger to land in. Account-wide events for orders we did not place are rejected as unowned.
 *  - ONE PROJECTION OF TRUTH. Stream and REST both funnel through the same projection, so dedup
 *    and monotonicity hold across both sources; a stream only ever makes the SAME truth arrive
 *    sooner, never a second, racing truth.
 *  - MISSING ≠ ZERO. An observation whose quantity is ABSENT (a Kite postback with no
 *    filled_quantity, a Dhan TRADED/CANCELLED with no TradedQty) is attributed but applies NO
 *    quantity; it schedules a targeted REST reconciliation to obtain the real figure. It is never
 *    read as a confirmed zero fill.
 *  - SOCKET-OPEN IS NOT READY. Health is driven by the state machine: only a completed
 *    reconciliation reaches READY. Loss → DISCONNECTED (bounded REST, no new entry, exposure
 *    management continues); reconnect → RECONCILING until the gap is repaired; auth reject →
 *    AUTH_EXPIRED. A missing event is never a zero fill.
 *
 * PURITY. This class holds no sockets and no timers of its own. The transports own the sockets and
 * call the lifecycle hooks; the clock is injected. REST reconciliation is a callback the caller
 * (which owns the adapter's REST transport) supplies, so this class never makes a network call.
 */

import {
  OrderUpdateProjection,
  type IngestResult,
  type NormalizedOrderObservation,
  type OrderStreamHealth,
} from "./orderUpdateProjection.js";
import {
  OrderStreamStateMachine,
  type OperationPermissions,
  type OrderStreamLifecycleState,
} from "./streamHealthPolicy.js";
import type { BrokerAdapter, ExternalOrderUpdate } from "./brokerAdapter.js";
import type { BrokerId } from "./latencyModel.js";

/** A box leg registered as durable intent, BEFORE the broker POST. */
export interface RegisterIntentArgs {
  readonly clientOrderId: string;
  /** Zerodha tag / Dhan correlationId — the stable strategy key echoed on every event. */
  readonly ownerTag: string;
  /** The trading account (Kite user_id / Dhan ClientId), for foreign-account rejection. */
  readonly account?: string | null;
  readonly requestedQty: number;
  /** Known only after acknowledgement; a pre-POST registration passes null. */
  readonly brokerOrderId?: string | null;
}

export interface OrderStreamConsumerOptions {
  readonly broker: BrokerId;
  /** The active trading account, read fresh so a session change is reflected. */
  readonly account: () => string | null;
  /**
   * The live execution adapter. Its {@link BrokerAdapter.applyOrderUpdate} is the seam that wakes
   * order waiters; when absent (a paper deployment), observations still update the projection but
   * wake nothing — which is honest, because there is nothing live to wake.
   */
  readonly adapter?: Pick<BrokerAdapter, "applyOrderUpdate"> | null;
  /** Whether the order-update stream is armed at all. When false, this is a pure REST accountant. */
  readonly streamEnabled: boolean;
  /**
   * Targeted REST reconciliation for ONE order, invoked when a stream event is owned but carries
   * INSUFFICIENT quantity evidence. The caller owns the adapter's REST transport and feeds the
   * result back via {@link ingestRestObservation}; this class never makes a network call itself.
   * Fail-open: a reconciliation error must not throw into the ingestion path.
   */
  readonly restReconcile?: (clientOrderId: string) => Promise<void>;
  /**
   * The POST-RECONNECT GAP-REPAIR SWEEP (D4). Invoked by {@link runReconnectReconciliation} while
   * the machine is RECONCILING, this reconciles durable nonterminal orders and attributed
   * positions against the broker over REST. It is handed an `ingestRest` callback so every
   * observation it recovers is funnelled through the SAME single projection — so a gap fill and a
   * later stream redelivery of that same fill deduplicate and never double-count. The consumer
   * clears RECONCILING (→ READY) only AFTER this resolves consistently. Fail-open: a throwing
   * sweep leaves the machine RECONCILING and REST polling continues.
   */
  readonly reconcileSweep?: (
    ingestRest: (obs: IncomingObservation) => IngestResult,
  ) => Promise<void>;
  /**
   * Expected-idle bound (ms). A connected stream that delivers NO event for longer than this WHILE
   * a working order is outstanding is demoted to DEGRADED by {@link evaluateIdle} (D5). Silence on
   * an account with no working orders is NORMAL and never demotes. Default 15000.
   */
  readonly expectedIdleMs?: number;
  readonly now?: () => number;
}

/**
 * A single observation as the transports produce it, MINUS the source/time the consumer stamps.
 * `source` is filled in by the ingest method so a caller cannot mislabel a REST poll as a stream.
 */
export type IncomingObservation = Omit<NormalizedOrderObservation, "source"> & {
  readonly observedAtWall?: number | null;
  readonly observedAtMono?: number | null;
};

export class OrderStreamConsumer {
  private readonly proj = new OrderUpdateProjection();
  private readonly machine: OrderStreamStateMachine;
  private readonly opts: OrderStreamConsumerOptions;
  /** Client order ids for which a targeted REST reconciliation is outstanding. Bounded by orders. */
  private readonly pendingReconciliations = new Set<string>();
  private streamEventsApplied = 0;
  private streamEventsWokeAdapter = 0;
  private absentEvidenceEvents = 0;
  /**
   * WORKING ORDERS — the orders we are actually EXPECTING events for (D5). An order enters here on
   * registerIntent and leaves when it is observed complete (cumulative ≥ requested) or explicitly
   * settled by the manager. Idleness is only evidence of a problem when this set is non-empty:
   * a quiet stream on an account with nothing working is normal, not degraded.
   */
  private readonly workingOrders = new Set<string>();
  /** Requested quantity per registered order, so a completing observation can settle it. */
  private readonly requestedQtyOf = new Map<string, number>();
  /** Wall-clock ms of the last event delivered by the STREAM (never a REST poll). */
  private lastStreamEventAtWall: number | null = null;
  private readonly expectedIdleMs: number;

  constructor(opts: OrderStreamConsumerOptions) {
    this.opts = opts;
    this.machine = new OrderStreamStateMachine(opts.streamEnabled);
    this.proj.setStreamEnabled(opts.streamEnabled);
    this.expectedIdleMs = Math.max(0, opts.expectedIdleMs ?? 15_000);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /* ─────────────────────────── ownership registration (before the POST) ─────────────────────────── */

  /**
   * Register a box leg as durable intent enters SUBMITTING — BEFORE the broker POST.
   *
   * This is the durable-intent-first ordering: an order-update that beats the placement HTTP
   * response has a ledger to land in, and an account-wide event for an order we DID place is
   * attributable the instant it arrives. Idempotent (re-registering keeps the same ledger).
   */
  registerIntent(args: RegisterIntentArgs): void {
    this.proj.register({
      clientOrderId: args.clientOrderId,
      ownerTag: args.ownerTag,
      account: args.account ?? this.opts.account() ?? null,
      requestedQty: args.requestedQty,
      brokerOrderId: args.brokerOrderId ?? null,
    });
    // A freshly registered order is a WORKING order: we now EXPECT fill/terminal events for it, so
    // stream silence past the idle bound becomes evidence of a problem (D5). It leaves the set when
    // observed complete or explicitly settled.
    this.requestedQtyOf.set(args.clientOrderId, args.requestedQty);
    if (args.requestedQty > 0) this.workingOrders.add(args.clientOrderId);
  }

  /**
   * Explicitly settle an order that will produce no further events (a confirmed cancel/reject with
   * residual, a fully-reconciled terminal). The manager calls this so a cancelled-with-residual
   * order does not keep the idle detector expecting events that will never come.
   */
  markOrderSettled(clientOrderId: string): void {
    this.workingOrders.delete(clientOrderId);
  }

  /** How many orders are currently WORKING (events expected). For diagnostics and the idle gate. */
  workingOrderCount(): number {
    return this.workingOrders.size;
  }

  /** Bind a broker order id to the durable client identity once the broker reports it. */
  learnBrokerOrderId(clientOrderId: string, brokerOrderId: string | null): void {
    this.proj.learnBrokerOrderId(clientOrderId, brokerOrderId);
  }

  /* ─────────────────────────── observation ingestion ─────────────────────────── */

  /**
   * Ingest ONE observation from the broker STREAM (a Kite postback text frame or a Dhan
   * order_alert). Attributes and deduplicates through the projection, then — when a quantity was
   * present and it is ours — hands it to the adapter to wake waiters. When the quantity is ABSENT,
   * it schedules a targeted REST reconciliation rather than fabricating a zero.
   */
  ingestStreamObservation(obs: IncomingObservation): IngestResult {
    return this.ingest(obs, "order_update");
  }

  /**
   * Ingest ONE observation from a REST source (a poll, a correlation lookup, or the reconciliation
   * sweep). Same projection, so it deduplicates against the stream and cannot double-count. A REST
   * source never refreshes stream liveness (the projection enforces that), so a poll can never make
   * a dead stream look alive.
   */
  ingestRestObservation(
    obs: IncomingObservation,
    source: "rest_poll" | "reconciliation" = "rest_poll",
  ): IngestResult {
    const result = this.ingest(obs, source);
    if (result.clientOrderId && result.quantityEvidence === "confirmed") {
      this.pendingReconciliations.delete(result.clientOrderId);
    }
    return result;
  }

  private ingest(obs: IncomingObservation, source: NormalizedOrderObservation["source"]): IngestResult {
    const stamped: NormalizedOrderObservation = {
      ...obs,
      source,
      observedAtWall: obs.observedAtWall ?? this.now(),
      observedAtMono: obs.observedAtMono ?? null,
    };
    const result = this.proj.ingest(stamped);

    // STREAM LIVENESS (D5). A genuine stream delivery — with or without a quantity — proves the
    // socket is delivering RIGHT NOW, so it resets the idle clock. A REST poll never does this, so
    // a poll can never mask a dead stream as alive.
    if ((source === "order_update" || source === "postback") && result.attributed) {
      this.lastStreamEventAtWall = stamped.observedAtWall ?? this.now();
    }

    if (!result.attributed || result.clientOrderId === null) return result;

    if (result.quantityEvidence === "absent") {
      // INSUFFICIENT EVIDENCE. Owned, but no quantity — never a zero fill. Obtain the truth by
      // targeted REST reconciliation, and wake the adapter's waiter with an ABSENT quantity so a
      // status-only frame does not stall the loop but also does not fabricate a fill.
      this.absentEvidenceEvents++;
      this.applyToAdapter(result.clientOrderId, stamped, /* quantityAbsent */ true);
      this.scheduleReconciliation(result.clientOrderId);
      return result;
    }

    // A confirmed quantity that the ledger actually advanced (or a fresh confirmed zero) is handed
    // to the adapter to wake waiters. A duplicate/stale event carries nothing new, so it need not
    // disturb the adapter — the ledger already deduplicated it.
    if (result.apply && (result.apply.outcome === "applied" || result.apply.outcome === "applied_overfill")) {
      this.applyToAdapter(result.clientOrderId, stamped, /* quantityAbsent */ false);
    }

    // WORKING-ORDER SETTLEMENT (D5). When the ledger reports this order fully filled, it no longer
    // expects events, so it leaves the working set — a subsequent quiet period is then normal.
    if (result.apply && result.apply.remaining <= 0) {
      this.workingOrders.delete(result.clientOrderId);
    }
    return result;
  }

  private applyToAdapter(clientOrderId: string, obs: NormalizedOrderObservation, quantityAbsent: boolean): void {
    const adapter = this.opts.adapter;
    if (!adapter?.applyOrderUpdate) return;
    const update: ExternalOrderUpdate = {
      clientOrderId,
      brokerOrderId: obs.brokerOrderId ?? null,
      // ABSENT quantity is conveyed as `undefined` so the adapter's `readNonNegativeInteger` sees a
      // genuine gap — a fabricated 0 would let a terminal label terminalise on nothing.
      cumulativeQty: quantityAbsent ? (undefined as unknown as number) : obs.cumulativeQty,
      averagePrice: obs.averagePrice ?? null,
      rawStatus: obs.rawStatus ?? null,
      observedAtWall: obs.observedAtWall ?? this.now(),
    };
    try {
      const merged = adapter.applyOrderUpdate(update);
      this.streamEventsApplied++;
      if (merged) this.streamEventsWokeAdapter++;
    } catch {
      // A single order's apply fault must never break stream ingestion for the others.
    }
  }

  private scheduleReconciliation(clientOrderId: string): void {
    if (!this.opts.restReconcile) return;
    if (this.pendingReconciliations.has(clientOrderId)) return;
    this.pendingReconciliations.add(clientOrderId);
    void Promise.resolve()
      .then(() => this.opts.restReconcile?.(clientOrderId))
      .catch(() => {
        // Fail-open: leave the pending flag so a later sweep retries; never throw into ingestion.
      });
  }

  /* ─────────────────────────── transport lifecycle → health ─────────────────────────── */

  onConnecting(): void {
    this.machine.onConnecting();
    this.proj.onStreamConnecting();
  }

  /** Socket open — NOT ready. Authorisation and synchronization are still owed. */
  onSocketOpen(): void {
    this.machine.onSocketOpen();
  }

  /** Authorised. Always enters RECONCILING (a gap is owed, even on first connect). */
  onAuthenticated(): void {
    const reconnect = this.machine.isReconnect();
    this.machine.onAuthenticated();
    this.proj.onStreamConnected({ authorised: true, reconnect });
    // A fresh (re)connect resets the idle clock: silence is measured from when the socket became
    // authorised, not from a stale pre-disconnect event.
    this.lastStreamEventAtWall = this.now();
  }

  /**
   * The reconnect reconciliation sweep is complete and consistent. ONLY path to READY. The caller
   * invokes this AFTER it has fed every reconciled REST observation back via ingestRestObservation.
   */
  markSynchronized(): void {
    this.machine.markSynchronized();
    this.proj.markReconciled();
  }

  /**
   * DRIVE THE POST-RECONNECT GAP-REPAIR SWEEP TO COMPLETION (D4).
   *
   * Called by the caller (the engine) whenever the machine is RECONCILING — on first connect and
   * on every reconnect. It runs the injected {@link OrderStreamConsumerOptions.reconcileSweep},
   * handing it an `ingestRest` funnel so every recovered observation goes through the SAME single
   * projection: a fill that happened in the disconnect gap (which the broker does NOT replay) is
   * recovered and counted exactly once, and a stream event that arrives DURING the sweep merges
   * monotonically without double-counting. Only AFTER the sweep resolves does the machine leave
   * RECONCILING (→ READY). Fail-open: a throwing sweep leaves it RECONCILING and REST continues.
   *
   * Idempotent and safe to poll: it is a no-op unless a reconciliation is actually owed.
   */
  async runReconnectReconciliation(): Promise<void> {
    if (!this.reconcilePending()) return;
    const sweep = this.opts.reconcileSweep;
    if (!sweep) {
      // No explicit sweep supplied: nothing can prove consistency, so stay RECONCILING. This is
      // deliberately conservative — a gap that cannot be repaired must not silently read READY.
      return;
    }
    try {
      await sweep((obs) => this.ingestRestObservation(obs, "reconciliation"));
      // The sweep completed and every recovered observation is in the single projection. NOW the
      // machine may leave RECONCILING.
      this.markSynchronized();
    } catch {
      // Fail-open: leave RECONCILING/DISCONNECTED as-is; the next poll retries. Never throw.
    }
  }

  /** Connected but not delivering usable events within the expected idle bound. */
  onIdle(): void {
    this.machine.onIdle();
  }

  /**
   * DRIVE THE ZERODHA MULTIPLEXED-QUOTE-SOCKET LIFECYCLE (D6).
   *
   * Zerodha carries order postbacks as TEXT frames on the SAME quote socket that carries the
   * ticks (docs/BROKER_STREAM_DOCS.md), so there is no separate order socket to open — the
   * order-stream health MUST be driven by the quote socket's connection lifecycle. A
   * `connected=true` edge means the quote socket is open AND authorised (the box lane only opens
   * once it holds credentials), so this walks CONNECTING → socket-open → authenticated, landing in
   * RECONCILING, and drives the post-(re)connect gap-repair sweep (D4) to completion — the only
   * path to READY. A `connected=false` edge is a disconnect. Inert when the stream is DISABLED.
   *
   * Returns the promise of the reconnect reconciliation so a caller may await it in tests; in
   * production the engine fires it and does not block the socket callback.
   */
  driveQuoteSocketLifecycle(connected: boolean): Promise<void> {
    if (this.machine.state() === "DISABLED") return Promise.resolve();
    if (connected) {
      this.onConnecting();
      this.onSocketOpen();
      this.onAuthenticated();
      return this.runReconnectReconciliation();
    }
    this.onDisconnected();
    return Promise.resolve();
  }

  /**
   * DRIVE IDLENESS FROM A REAL CLOCK (D5).
   *
   * Called on a poll with the current wall time. It demotes a connected stream (READY/RECONCILING)
   * to DEGRADED ONLY when BOTH are true:
   *   1. a WORKING order is outstanding (we are actually EXPECTING events), and
   *   2. no stream event has arrived for longer than the expected-idle bound.
   * A quiet stream on an account with nothing working is NORMAL and never demotes — the alarm is
   * based on working-order expectation, not wall-clock silence alone. Any real stream event resets
   * the clock (see ingest), so a live-but-slow stream is not falsely flagged.
   */
  evaluateIdle(nowWall?: number): void {
    if (this.workingOrders.size === 0) return; // silence is expected — no false alarm
    const state = this.machine.state();
    if (state !== "READY" && state !== "RECONCILING") return;
    const now = nowWall ?? this.now();
    const since = this.lastStreamEventAtWall;
    if (since === null) return; // never connected/authorised long enough to measure
    if (now - since > this.expectedIdleMs) {
      this.machine.onIdle();
    }
  }

  onDisconnected(): void {
    this.machine.onDisconnected();
    this.proj.onStreamDisconnected();
  }

  onSessionLost(_reason: string): void {
    this.machine.onSessionLost();
    // A lost session is also a disconnect for the projection's gap accounting.
    this.proj.onStreamDisconnected();
  }

  setStreamEnabled(enabled: boolean): void {
    this.machine.setEnabled(enabled);
    this.proj.setStreamEnabled(enabled);
  }

  /* ─────────────────────────── reads ─────────────────────────── */

  lifecycleState(): OrderStreamLifecycleState {
    return this.machine.state();
  }

  permissions(): OperationPermissions {
    return this.machine.permissions();
  }

  reconcilePending(): boolean {
    return this.machine.reconcilePending() || this.proj.reconcilePending();
  }

  /** The order-stream health snapshot, for the operator-facing status. Its OWN signal. */
  health(): OrderStreamHealth {
    return this.proj.orderStreamHealth();
  }

  /** The single projection of truth for this broker account. */
  projection(): OrderUpdateProjection {
    return this.proj;
  }

  diagnostics(): {
    lifecycle: OrderStreamLifecycleState;
    streamEventsApplied: number;
    streamEventsWokeAdapter: number;
    absentEvidenceEvents: number;
    pendingReconciliations: number;
    projection: ReturnType<OrderUpdateProjection["diagnostics"]>;
  } {
    return {
      lifecycle: this.machine.state(),
      streamEventsApplied: this.streamEventsApplied,
      streamEventsWokeAdapter: this.streamEventsWokeAdapter,
      absentEvidenceEvents: this.absentEvidenceEvents,
      pendingReconciliations: this.pendingReconciliations.size,
      projection: this.proj.diagnostics(),
    };
  }
}
