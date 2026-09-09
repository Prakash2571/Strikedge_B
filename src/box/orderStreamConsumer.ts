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

  constructor(opts: OrderStreamConsumerOptions) {
    this.opts = opts;
    this.machine = new OrderStreamStateMachine(opts.streamEnabled);
    this.proj.setStreamEnabled(opts.streamEnabled);
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
  }

  /**
   * The reconnect reconciliation sweep is complete and consistent. ONLY path to READY. The caller
   * invokes this AFTER it has fed every reconciled REST observation back via ingestRestObservation.
   */
  markSynchronized(): void {
    this.machine.markSynchronized();
    this.proj.markReconciled();
  }

  /** Connected but not delivering usable events within the expected idle bound. */
  onIdle(): void {
    this.machine.onIdle();
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
