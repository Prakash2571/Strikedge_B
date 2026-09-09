/**
 * UNIFIED ORDER-UPDATE PROJECTION — ONE truth for every observation of an order.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────
 * The backend historically observed fills by REST POLLING only. Two fast paths were
 * available and unused: Zerodha streams order postbacks as TEXT frames on the very socket
 * `ticker.ts` was already holding open — and discarding at `ticker.ts:100` ("Text frames are
 * postbacks (order updates / error messages) — ignore.") — and Dhan exposes a DEDICATED
 * order-update WebSocket (`wss://api-order-update.dhan.co`, distinct from the market feed at
 * `wss://api-feed.dhan.co`).
 *
 * The hazard in adding a second observation source is creating a SECOND TRUTH: a stream
 * that says one thing and a REST poll that says another, racing to overwrite each other.
 * This module refuses that. Stream events and REST snapshots are both funnelled into ONE
 * per-order {@link CumulativeFillLedger} (see orderLifecycle.ts), which is idempotent,
 * monotonic and cumulative-authoritative. A duplicate — whether a redelivered stream event
 * or a REST poll that overlaps a stream event — is a non-event. An out-of-order arrival
 * cannot rewind quantity. The stream only ever makes the SAME truth arrive SOONER.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * THE FIVE RULES THIS FILE ENCODES
 * ─────────────────────────────────────────────────────────────────────────────────────
 *  1. OWNERSHIP FIRST. An event is attributed to a box leg ONLY when its ownership key
 *     (Zerodha tag / Dhan correlation id) matches a registered order for THIS account.
 *     An event for another app's order on the same trading account is dropped, never
 *     attributed. See {@link OrderUpdateProjection.ingest}.
 *  2. ONE LEDGER PER ORDER. Every observation — stream or REST — routes through the same
 *     ledger, so dedup and monotonicity are enforced across BOTH sources at once.
 *  3. STREAM LOSS FABRICATES NOTHING. A disconnect records a health gap; it never invents
 *     a terminal state and never disables exposure management. Truth on reconnect comes
 *     from REST reconciliation, not from assuming the gap was empty.
 *  4. MARKET-DATA HEALTH ≠ ORDER-STREAM HEALTH. They are independent signals with
 *     independent state. A live market feed can coexist with a dead order stream, and this
 *     module reports the order stream's own health so that case is visible, not masked.
 *  5. PROMPT PUBLICATION (Dhan). Authoritative cumulative fill evidence is applied the
 *     instant the order snapshot carries it. Nothing here blocks on a trade-detail
 *     enrichment fetch — the transports hand this module the cumulative quantity directly.
 *
 * PURITY. No clock, no sockets, no timers. Times are supplied by the caller from the
 * injected execution clock, so a recorded event stream replays identically in a test.
 */

import {
  CumulativeFillLedger,
  type CumulativeFillEvent,
  type FillApplyResult,
  type FillEventSource,
  type FillLedgerSnapshot,
} from "./orderLifecycle.js";

/**
 * The identity by which an observation is attributed to a registered order.
 *
 * BOTH brokers give us a strategy-controlled key that survives a restart:
 *   - Zerodha: the order `tag` (see `stableKiteTag`), echoed on every postback.
 *   - Dhan: the `CorrelationId` (see `dhanCorrelationId`), echoed on every order_alert.
 * The broker's own order id is ALSO accepted, because after acknowledgement we know it and
 * a late event may carry only that. The account id is validated separately so an event for
 * a DIFFERENT account can never match even if a key were reused.
 */
export interface OrderOwnershipKey {
  /** The stable strategy-controlled key (Zerodha tag / Dhan correlationId). */
  readonly ownerTag: string;
  /** The broker's own order id, once known. A late event may carry only this. */
  readonly brokerOrderId?: string | null;
  /**
   * The trading account the order belongs to (Kite user_id / Dhan ClientId). An event whose
   * account does not match is NEVER attributed — this is what stops another app's order on
   * the SAME account, or a cross-account leak, from being counted as ours.
   */
  readonly account?: string | null;
}

/** A registered box leg order the projection will attribute events to. */
export interface RegisteredOrder extends OrderOwnershipKey {
  readonly clientOrderId: string;
  readonly requestedQty: number;
}

/**
 * A normalized, broker-neutral order observation.
 *
 * The transports (zerodha/orderUpdates.ts, dhan/orderFeed.ts) and the REST adapters all
 * produce this shape. Crucially it carries the CUMULATIVE quantity (never a delta) plus the
 * ownership keys — everything needed to attribute AND to apply, with no follow-up fetch.
 */
export interface NormalizedOrderObservation extends OrderOwnershipKey {
  /** Broker cumulative filled quantity AFTER this observation. Authoritative. */
  readonly cumulativeQty: number;
  /** Broker cumulative average fill price, when reported. */
  readonly averagePrice?: number | null;
  /** Broker status string, verbatim, for diagnostics. Never the basis for quantity. */
  readonly rawStatus?: string | null;
  /**
   * A stable per-event identity when the broker supplies one (an order-update sequence
   * token, an exchange update timestamp). Absent ⇒ dedup falls back to cumulative
   * monotonicity, which is still safe.
   */
  readonly eventId?: string | null;
  /** A broker-side monotonic sequence, when available. Diagnostic only. */
  readonly sequence?: number | null;
  readonly source: FillEventSource;
  readonly observedAtMono?: number | null;
  readonly observedAtWall?: number | null;
}

/** Why an ingested observation was not applied to a ledger. */
export type IngestRejection =
  /** No registered order matched the ownership key — likely another app's order. */
  | "unowned"
  /** The account on the event did not match the registered order's account. */
  | "foreign_account"
  /** The observation was malformed (non-finite / negative cumulative quantity). */
  | "malformed";

export interface IngestResult {
  /** True when the observation was attributed to a registered order and applied. */
  readonly attributed: boolean;
  readonly clientOrderId: string | null;
  /** Present only when attributed: the ledger outcome (applied / duplicate / stale / …). */
  readonly apply: FillApplyResult | null;
  /** Present only when NOT attributed: why. */
  readonly rejection: IngestRejection | null;
  readonly source: FillEventSource;
}

/**
 * ORDER-STREAM HEALTH — deliberately its OWN type, structurally separate from the
 * market-data `FeedHealth` in brokers/feedHealth.ts.
 *
 * The point of a distinct type (not a shared one with a flag) is that the two CANNOT be
 * confused at a call site: a function that wants order-stream health cannot be handed
 * market-data health by accident, and a dashboard cannot render one where it meant the
 * other. A functioning market-data socket is NOT evidence of a functioning order stream.
 */
export type OrderStreamState =
  /** The order stream is intentionally off (not configured / not live). Not a fault. */
  | "DISABLED"
  /** Configured but never connected, or lost and reconnecting. */
  | "DOWN"
  /** A connection attempt is in flight. */
  | "CONNECTING"
  /** Connected and authorised; order updates will arrive here first. */
  | "LIVE"
  /**
   * Was LIVE, then dropped. Fills may have occurred in the gap. Distinct from DOWN because
   * it MANDATES a REST reconciliation before the stream is trusted again — the gap must be
   * repaired from REST, never assumed empty.
   */
  | "RECONNECTED_PENDING_RECONCILE";

export interface OrderStreamHealth {
  readonly state: OrderStreamState;
  readonly connected: boolean;
  readonly authorised: boolean;
  /** Wall-clock ms of the last order update received, or null. */
  readonly lastEventAt: number | null;
  /** Number of disconnects observed this session. Each one implies a reconciliation. */
  readonly disconnects: number;
  /** True while a post-reconnect REST reconciliation is still owed. */
  readonly reconcilePending: boolean;
  /** Human-readable, safe to display. */
  readonly detail: string;
}

/**
 * The projection.
 *
 * Owns: the registry of box orders, one ledger per order, and the order-stream health
 * signal. Does NOT own: sockets, clocks, or the durable store. Callers register orders as
 * durable intent is persisted (CREATED → SUBMITTING already happens BEFORE submission, and
 * this registry is populated at/around that same point so a pre-arrival event has somewhere
 * to land), then feed every observation through {@link ingest}.
 */
export class OrderUpdateProjection {
  private readonly ledgers = new Map<string, CumulativeFillLedger>();
  /** ownerTag → clientOrderId, for stream/REST attribution by the strategy key. */
  private readonly byOwnerTag = new Map<string, string>();
  /** brokerOrderId → clientOrderId, learned once the broker id is known. */
  private readonly byBrokerOrderId = new Map<string, string>();
  /** clientOrderId → the account it belongs to, for foreign-account rejection. */
  private readonly accountOf = new Map<string, string | null>();

  /** Order-stream health, tracked independently of any market-data feed. */
  private streamState: OrderStreamState = "DISABLED";
  private streamConnected = false;
  private streamAuthorised = false;
  private lastEventAtWall: number | null = null;
  private disconnectCount = 0;
  private reconcileOwed = false;
  /**
   * Attribution failures, retained for diagnostics. A steady stream of `unowned` events is
   * normal (the account trades elsewhere); a spike in `foreign_account` is not.
   */
  private unownedCount = 0;
  private foreignAccountCount = 0;

  /**
   * Register (or re-register) a box order so its events can be attributed and its fills
   * accounted. Idempotent: re-registering keeps the SAME ledger, so a duplicate registration
   * on restart-adoption never resets accumulated exposure. This is the durable-intent-first
   * ordering: the caller registers as it persists CREATED/SUBMITTING, BEFORE the POST — which
   * is exactly what lets a fill that beats the placement HTTP response find a home.
   */
  register(order: RegisteredOrder): void {
    if (!this.ledgers.has(order.clientOrderId)) {
      this.ledgers.set(order.clientOrderId, new CumulativeFillLedger(order.clientOrderId, order.requestedQty));
    }
    const tag = order.ownerTag.trim();
    if (tag) this.byOwnerTag.set(tag, order.clientOrderId);
    this.accountOf.set(order.clientOrderId, order.account ?? null);
    this.learnBrokerOrderId(order.clientOrderId, order.brokerOrderId ?? null);
  }

  /**
   * Learn a broker order id for an already-registered order (after acknowledgement).
   *
   * Late events sometimes carry only the broker id, so this index lets them still attribute.
   */
  learnBrokerOrderId(clientOrderId: string, brokerOrderId: string | null): void {
    const id = brokerOrderId?.trim();
    if (id) this.byBrokerOrderId.set(id, clientOrderId);
  }

  hasOrder(clientOrderId: string): boolean {
    return this.ledgers.has(clientOrderId);
  }

  ledger(clientOrderId: string): CumulativeFillLedger | undefined {
    return this.ledgers.get(clientOrderId);
  }

  snapshot(clientOrderId: string): FillLedgerSnapshot | undefined {
    return this.ledgers.get(clientOrderId)?.snapshot();
  }

  /**
   * Ingest ONE normalized observation from ANY source (stream or REST).
   *
   * Order of checks, and why:
   *  1. MALFORMED → reject. A non-finite/negative cumulative quantity is not information.
   *  2. RESOLVE OWNERSHIP by tag, then by broker order id. No match ⇒ `unowned`: this is an
   *     order we did not place (or have not registered yet). It is DROPPED — attributing
   *     another app's fill to a box leg is the worst outcome available here.
   *  3. VALIDATE ACCOUNT. If the observation names an account and it differs from the
   *     registered order's account, reject as `foreign_account` even though the tag matched:
   *     a reused key across accounts must never cross the boundary.
   *  4. APPLY through the order's single ledger, which enforces dedup + monotonicity across
   *     stream and REST alike.
   *
   * A stream observation additionally refreshes order-stream liveness — but ONLY the stream
   * source does, so a REST poll can never make a dead stream look alive.
   */
  ingest(obs: NormalizedOrderObservation): IngestResult {
    if (obs.source === "order_update" || obs.source === "postback") {
      // Any genuine stream delivery is evidence the stream is alive right now.
      if (obs.observedAtWall != null && Number.isFinite(obs.observedAtWall)) {
        this.lastEventAtWall = obs.observedAtWall;
      }
    }

    if (!Number.isFinite(obs.cumulativeQty) || obs.cumulativeQty < 0) {
      return { attributed: false, clientOrderId: null, apply: null, rejection: "malformed", source: obs.source };
    }

    const clientOrderId = this.resolveOwner(obs);
    if (clientOrderId === null) {
      this.unownedCount++;
      return { attributed: false, clientOrderId: null, apply: null, rejection: "unowned", source: obs.source };
    }

    const expectedAccount = this.accountOf.get(clientOrderId) ?? null;
    if (
      expectedAccount !== null &&
      obs.account != null &&
      String(obs.account).trim() !== "" &&
      String(obs.account).trim() !== expectedAccount
    ) {
      this.foreignAccountCount++;
      return { attributed: false, clientOrderId, apply: null, rejection: "foreign_account", source: obs.source };
    }

    // Once the broker id is present on an owned event, remember it so a later broker-id-only
    // event still attributes.
    if (obs.brokerOrderId) this.learnBrokerOrderId(clientOrderId, obs.brokerOrderId);

    const ledger = this.ledgers.get(clientOrderId);
    if (!ledger) {
      // Registered by tag but the ledger is gone (should not happen): treat as unowned rather
      // than silently create a zero-requested ledger that could accept an overfill for nothing.
      this.unownedCount++;
      return { attributed: false, clientOrderId, apply: null, rejection: "unowned", source: obs.source };
    }

    const event: CumulativeFillEvent = {
      cumulativeQty: obs.cumulativeQty,
      averagePrice: obs.averagePrice ?? null,
      eventId: obs.eventId ?? null,
      sequence: obs.sequence ?? null,
      observedAtMono: obs.observedAtMono ?? null,
      observedAtWall: obs.observedAtWall ?? null,
      source: obs.source,
    };
    const apply = ledger.apply(event);
    return { attributed: true, clientOrderId, apply, rejection: null, source: obs.source };
  }

  private resolveOwner(key: OrderOwnershipKey): string | null {
    const tag = key.ownerTag?.trim();
    if (tag) {
      const byTag = this.byOwnerTag.get(tag);
      if (byTag) return byTag;
    }
    const brokerId = key.brokerOrderId?.trim();
    if (brokerId) {
      const byId = this.byBrokerOrderId.get(brokerId);
      if (byId) return byId;
    }
    return null;
  }

  /* ─────────────────────────── order-stream health ─────────────────────────── */

  /**
   * Declare whether the order stream is configured at all.
   *
   * Off by default: until this is called with `true`, health is DISABLED and the projection
   * is a pure REST accountant. The stream is inert unless explicitly enabled, consistent with
   * how the rest of the codebase gates live behaviour — and a stream can NEVER place an order,
   * it only observes.
   */
  setStreamEnabled(enabled: boolean): void {
    if (!enabled) {
      this.streamState = "DISABLED";
      this.streamConnected = false;
      this.streamAuthorised = false;
      return;
    }
    if (this.streamState === "DISABLED") this.streamState = "DOWN";
  }

  /** A connection attempt has begun. */
  onStreamConnecting(): void {
    if (this.streamState === "DISABLED") return;
    this.streamConnected = false;
    this.streamState = "CONNECTING";
  }

  /**
   * The order stream connected AND authorised.
   *
   * If this is a RECONNECT (we had connected before and since disconnected), a REST
   * reconciliation is now owed: events may have occurred in the gap and MUST be repaired from
   * REST, not assumed absent. `reconcileOwed` stays true until {@link markReconciled}.
   */
  onStreamConnected(args: { authorised: boolean; reconnect: boolean }): void {
    if (this.streamState === "DISABLED") return;
    this.streamConnected = true;
    this.streamAuthorised = args.authorised;
    if (args.reconnect) {
      this.reconcileOwed = true;
      this.streamState = "RECONNECTED_PENDING_RECONCILE";
    } else {
      this.streamState = "LIVE";
    }
  }

  /**
   * The order stream dropped.
   *
   * FABRICATES NOTHING. It does not touch any ledger, does not invent a terminal state, and
   * does not disable exposure management. It records that a gap exists so the caller keeps
   * polling REST and reconciles on reconnect.
   */
  onStreamDisconnected(): void {
    if (this.streamState === "DISABLED") return;
    this.streamConnected = false;
    this.streamAuthorised = false;
    this.disconnectCount++;
    this.reconcileOwed = true;
    this.streamState = "DOWN";
  }

  /**
   * A post-reconnect REST reconciliation completed.
   *
   * Only NOW may the stream be considered fully LIVE again. Calling this without having
   * actually reconciled would reintroduce the very gap this guards against, so callers must
   * call it after the REST sweep, not before.
   */
  markReconciled(): void {
    if (this.streamState === "DISABLED") return;
    this.reconcileOwed = false;
    if (this.streamConnected) this.streamState = "LIVE";
  }

  /** True while a reconnect reconciliation is still owed. Callers gate the REST sweep on it. */
  reconcilePending(): boolean {
    return this.reconcileOwed;
  }

  /**
   * Order-stream health — its OWN signal, never derived from the market-data feed.
   *
   * Event-driven, so it needs no clock: the state transitions on connect/disconnect/reconcile
   * and `lastEventAt` is stamped by ingested stream observations.
   */
  orderStreamHealth(): OrderStreamHealth {
    const detail = this.describeStream();
    return {
      state: this.streamState,
      connected: this.streamConnected,
      authorised: this.streamAuthorised,
      lastEventAt: this.lastEventAtWall,
      disconnects: this.disconnectCount,
      reconcilePending: this.reconcileOwed,
      detail,
    };
  }

  private describeStream(): string {
    switch (this.streamState) {
      case "DISABLED":
        return "Order-update stream disabled — fills are observed by REST polling only.";
      case "DOWN":
        return "Order-update stream is down — REST polling remains the source of truth.";
      case "CONNECTING":
        return "Connecting to the order-update stream…";
      case "LIVE":
        return "Order-update stream live — fills observed here first, REST reconciles.";
      case "RECONNECTED_PENDING_RECONCILE":
        return "Order-update stream reconnected — a REST reconciliation is owed before it is trusted.";
    }
  }

  diagnostics(): {
    orders: number;
    unowned: number;
    foreignAccount: number;
    disconnects: number;
    reconcilePending: boolean;
  } {
    return {
      orders: this.ledgers.size,
      unowned: this.unownedCount,
      foreignAccount: this.foreignAccountCount,
      disconnects: this.disconnectCount,
      reconcilePending: this.reconcileOwed,
    };
  }
}
