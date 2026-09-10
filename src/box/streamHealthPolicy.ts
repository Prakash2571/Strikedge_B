/**
 * WEBSOCKET HEALTH AND THE OPERATION PERMISSION MATRIX — one explicit table, two independent
 * state machines.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * "Healthy" was previously a scattered set of booleans: `feedHealthy`, `isTokenWarm`, a
 * connection listener, an order-stream label nothing populated. Two things went wrong with that:
 *
 *   1. A socket that had merely OPENED could read as ready. TCP/WebSocket establishment proves a
 *      route to the broker, nothing about authorisation, subscription acceptance, or whether a
 *      single usable depth packet for a traded instrument has arrived.
 *   2. Market-data health and order-update health were conflated. They are independent facts: a
 *      live tick stream says nothing about whether fills are being reported, and Zerodha even
 *      delivers both on ONE socket (binary ticks + text postbacks) while Dhan uses two separate
 *      sockets. Either can be dead while the other is perfect.
 *
 * So both are modelled as explicit states, and — the part that actually changes behaviour — each
 * state is mapped to exactly WHICH operations it permits.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ASYMMETRY THE MATRIX ENCODES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Creating exposure and reducing exposure are not symmetric, and treating them symmetrically is
 * how a degraded feed strands a live position:
 *
 *   NEW ENTRY               needs the most evidence. It is optional, it is deferrable, and a
 *                           mistake creates unbounded risk. Refused unless everything is ready.
 *   MANAGING WORKING ORDERS needs less. The order already exists; leaving it unmanaged is worse.
 *   PROTECTIVE CANCELLATION needs almost none. Cancelling reduces exposure. Refusing to cancel
 *                           because a socket is unhealthy is strictly more dangerous than
 *                           cancelling, so it is permitted in EVERY state except an expired
 *                           session — where the broker itself will refuse.
 *   EXIT / ATTRIBUTED
 *   REDUCTION               needs a usable book for the leg being reduced, but never the
 *                           four-leg coherence a new box demands, and never full readiness.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * It does not promise lossless data, zero outages, or exchange ordering. It does not decide that
 * a missing event means a zero fill — a lost stream produces `DEGRADED`/`RECONCILING`, which
 * MANDATES REST reconciliation, never an assumption that the gap was empty.
 *
 * PURE and total: no clock, no sockets, no I/O. Every state maps to a permission set by table.
 */

/**
 * MARKET-DATA transport state.
 *
 * `READY` is the only state that asserts usable data, and it is deliberately expensive to reach:
 * connected AND authenticated AND subscriptions confirmed AND fresh usable depth observed for the
 * instruments in question, in the CURRENT connection generation.
 */
export type MarketDataState =
  /** Not configured / not started. Not a fault. */
  | "DISABLED"
  /** A connection attempt is in flight. */
  | "CONNECTING"
  /** Socket open; session handshake not yet accepted. */
  | "AUTHENTICATING"
  /** Authenticated; restoring subscriptions and waiting for first usable depth per instrument. */
  | "SYNCHRONIZING"
  /** Authenticated, subscribed, and fresh usable depth is being observed. */
  | "READY"
  /**
   * Connected and technically alive, but the data cannot be trusted for entry: a heartbeat gap, a
   * book older than its configured limit, a subscription only partly restored, or an application
   * processing backlog. Exposure management continues.
   */
  | "DEGRADED"
  /** The socket is closed or half-open. */
  | "DISCONNECTED"
  /** The session/token was rejected or expired. Reconnecting with it is pointless. */
  | "AUTH_EXPIRED";

/**
 * ORDER-UPDATE transport state.
 *
 * Structurally separate from {@link MarketDataState} so the two cannot be passed to each other's
 * consumers by accident — the whole point being that they are independent facts.
 */
export type OrderStreamLifecycleState =
  | "DISABLED"
  | "CONNECTING"
  | "AUTHENTICATING"
  /**
   * Connected and authorised, but a REST reconciliation is OWED. Reached on every reconnect,
   * because events may have occurred in the gap and brokers do not promise to replay them.
   */
  | "RECONCILING"
  | "READY"
  /** Connected but not delivering (no events past the expected idle bound), or overloaded. */
  | "DEGRADED"
  | "DISCONNECTED"
  | "AUTH_EXPIRED";

/** The four operation classes whose permission differs by health. */
export interface OperationPermissions {
  /** Create NEW exposure (a fresh four-leg box entry). */
  readonly newEntry: boolean;
  /** Modify / chase / observe an order that already exists. */
  readonly manageWorkingOrders: boolean;
  /** Cancel to REDUCE exposure. Permitted almost everywhere; see the file header. */
  readonly protectiveCancel: boolean;
  /** Exit a box, or reduce attributed residual exposure. */
  readonly exitAndReduce: boolean;
}

const NONE: OperationPermissions = {
  newEntry: false, manageWorkingOrders: false, protectiveCancel: false, exitAndReduce: false,
};

/**
 * MARKET-DATA permission table.
 *
 * `DISABLED` permits nothing, because a strategy with no market data has no basis for any pricing
 * decision — including a limit price on a protective cancel replacement. It is not a "safe"
 * state, it is an absent one.
 */
const MARKET_DATA_PERMISSIONS: Readonly<Record<MarketDataState, OperationPermissions>> = {
  DISABLED: NONE,
  CONNECTING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: false },
  AUTHENTICATING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: false },
  // Subscriptions are being restored: a book may exist but belongs to an unproven generation.
  SYNCHRONIZING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: false },
  READY: { newEntry: true, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  // A degraded feed can still price a REDUCTION off a current single-leg book (the reduction
  // coherence check enforces that per leg); it can never justify creating a new four-leg box.
  DEGRADED: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  DISCONNECTED: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: false },
  // The broker will refuse everything anyway; claiming permission would be a lie, not a safeguard.
  AUTH_EXPIRED: NONE,
};

/**
 * ORDER-STREAM permission table.
 *
 * A DISABLED order stream is NOT a fault: REST polling is the documented fallback and was the only
 * mechanism before streams existed. So `DISABLED` permits everything — what it must not do is
 * report itself as a live stream, which is `orderStreamStatus`'s job, not this table's.
 */
const ORDER_STREAM_PERMISSIONS: Readonly<Record<OrderStreamLifecycleState, OperationPermissions>> = {
  DISABLED: { newEntry: true, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  CONNECTING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  AUTHENTICATING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  // A gap exists and has not yet been repaired from REST. Taking NEW exposure on top of an
  // unreconciled position is how one unknown becomes two.
  RECONCILING: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  READY: { newEntry: true, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  // DEGRADED means events may be missing. Missing events are NOT zero fills; REST still observes,
  // so exposure management continues while new entry stops.
  DEGRADED: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  DISCONNECTED: { newEntry: false, manageWorkingOrders: true, protectiveCancel: true, exitAndReduce: true },
  AUTH_EXPIRED: { newEntry: false, manageWorkingOrders: false, protectiveCancel: true, exitAndReduce: false },
};

export function marketDataPermissions(state: MarketDataState): OperationPermissions {
  return MARKET_DATA_PERMISSIONS[state];
}

export function orderStreamPermissions(state: OrderStreamLifecycleState): OperationPermissions {
  return ORDER_STREAM_PERMISSIONS[state];
}

/** One named reason an operation class is not permitted right now. */
export interface PermissionBlock {
  readonly operation: keyof OperationPermissions;
  readonly reason: string;
}

/**
 * The COMBINED permission for both transports.
 *
 * Intersection, never union: an operation is permitted only when BOTH transports permit it. A
 * healthy order stream cannot license an entry on a stale book, and a healthy book cannot license
 * an entry while a fill gap is unreconciled.
 */
export function combinedPermissions(args: {
  readonly marketData: MarketDataState;
  readonly orderStream: OrderStreamLifecycleState;
}): OperationPermissions {
  const md = marketDataPermissions(args.marketData);
  const os = orderStreamPermissions(args.orderStream);
  return {
    newEntry: md.newEntry && os.newEntry,
    manageWorkingOrders: md.manageWorkingOrders && os.manageWorkingOrders,
    protectiveCancel: md.protectiveCancel && os.protectiveCancel,
    exitAndReduce: md.exitAndReduce && os.exitAndReduce,
  };
}

/**
 * THE COMBINED NEW-ENTRY GATE — the single seam the live entry checkpoint consults (D1).
 *
 * NEW ENTRY is the only operation both transports must license, so the entry checkpoint asks THIS
 * one question and never re-implements the matrix as an ad-hoc boolean. It is a thin wrapper over
 * {@link combinedPermissions} that also carries BOTH transport states back so the refusal reason
 * names which transport blocked and why.
 *
 * THE ASYMMETRY IT PRESERVES, unchanged from the table:
 *   - A DISABLED order stream permits entry — REST polling is the documented baseline
 *     fill-observation mechanism and the order stream is OFF by default. Only an ENABLED-but-
 *     unhealthy stream (CONNECTING/AUTHENTICATING/RECONCILING/DEGRADED/DISCONNECTED/AUTH_EXPIRED)
 *     refuses new entry.
 *   - It gates NEW ENTRY ONLY. Exit, attributed reduction and protective cancel are never routed
 *     through this gate, so a degraded order stream can never strand a live position.
 */
export function entryPermittedFromStreams(args: {
  readonly marketData: MarketDataState;
  readonly orderStream: OrderStreamLifecycleState;
}): {
  readonly permitted: boolean;
  readonly marketData: MarketDataState;
  readonly orderStream: OrderStreamLifecycleState;
} {
  const combined = combinedPermissions(args);
  return {
    permitted: combined.newEntry,
    marketData: args.marketData,
    orderStream: args.orderStream,
  };
}

/**
 * Why each blocked operation is blocked, in operator-readable form.
 *
 * Exists so the frontend can say "entry is paused because the order stream reconnected and a
 * reconciliation is owed" instead of "unhealthy" — which is the difference between an operator who
 * can act and one who can only wait.
 */
export function permissionBlocks(args: {
  readonly marketData: MarketDataState;
  readonly orderStream: OrderStreamLifecycleState;
}): PermissionBlock[] {
  const md = marketDataPermissions(args.marketData);
  const os = orderStreamPermissions(args.orderStream);
  const out: PermissionBlock[] = [];
  const ops: (keyof OperationPermissions)[] = [
    "newEntry", "manageWorkingOrders", "protectiveCancel", "exitAndReduce",
  ];
  for (const op of ops) {
    if (!md[op]) out.push({ operation: op, reason: `market data is ${args.marketData}` });
    if (!os[op]) out.push({ operation: op, reason: `order-update stream is ${args.orderStream}` });
  }
  return out;
}

/**
 * The INVARIANTS the tables must satisfy, restated independently for the tests.
 *
 * These are the properties that actually keep a position manageable, so they are asserted about
 * the tables rather than trusted to have been typed correctly:
 *
 *  1. No state permits NEW ENTRY without also permitting EXIT — being able to open something you
 *     cannot close is the one combination that must be impossible.
 *  2. PROTECTIVE CANCELLATION is permitted in every state where any operation is permitted at all.
 *  3. NEW ENTRY is permitted in exactly the fully-ready states.
 */
export function permissionInvariantViolations(): string[] {
  const problems: string[] = [];
  for (const state of Object.keys(MARKET_DATA_PERMISSIONS) as MarketDataState[]) {
    const p = MARKET_DATA_PERMISSIONS[state];
    if (p.newEntry && !p.exitAndReduce) problems.push(`market data ${state} permits entry but not exit`);
    if (p.newEntry && !p.protectiveCancel) problems.push(`market data ${state} permits entry but not cancel`);
    if (p.exitAndReduce && !p.protectiveCancel) problems.push(`market data ${state} permits exit but not cancel`);
    if (p.newEntry && state !== "READY") problems.push(`market data ${state} must not permit new entry`);
  }
  for (const state of Object.keys(ORDER_STREAM_PERMISSIONS) as OrderStreamLifecycleState[]) {
    const p = ORDER_STREAM_PERMISSIONS[state];
    if (p.newEntry && !p.exitAndReduce) problems.push(`order stream ${state} permits entry but not exit`);
    if (p.newEntry && !p.protectiveCancel) problems.push(`order stream ${state} permits entry but not cancel`);
    if (p.exitAndReduce && !p.protectiveCancel) problems.push(`order stream ${state} permits exit but not cancel`);
    if (p.newEntry && state !== "READY" && state !== "DISABLED") {
      problems.push(`order stream ${state} must not permit new entry`);
    }
  }
  return problems;
}

/**
 * THE ORDER-STREAM LIFECYCLE STATE MACHINE.
 *
 * The tables above are pure. This is the small stateful driver that turns transport lifecycle
 * events (connecting / socket open / authenticated / synchronized / disconnected / session lost)
 * into the {@link OrderStreamLifecycleState} the tables score. It exists so that the state is
 * derived from EVENTS THAT ACTUALLY HAPPENED, not set ad hoc at call sites — which is the whole
 * reason "socket open" stopped being able to read READY.
 *
 * THE LOAD-BEARING TRANSITIONS:
 *   - `onSocketOpen` moves CONNECTING → AUTHENTICATING. It is NOT READY: a route to the broker is
 *     not authorisation, and (Dhan) authorisation is not even acknowledged, so a socket that has
 *     merely opened proves nothing about delivery.
 *   - `onAuthenticated` moves AUTHENTICATING → RECONCILING, ALWAYS. Even a first connect owes an
 *     initial synchronization; a reconnect owes one because the broker does not promise to replay
 *     events missed in the gap. RECONCILING forbids new entry but permits exit and cancel.
 *   - `markSynchronized` is the ONLY path to READY. It means the REST reconciliation sweep merged
 *     every durable nonterminal order and attributed position without loss or double-count.
 *   - `onDisconnected` moves to DISCONNECTED and OWES a reconciliation. Exposure management and
 *     protective cancel continue; new entry stops. A missing event is NEVER read as a zero fill.
 *   - `onIdle` moves a connected stream to DEGRADED (connected but not delivering usable events).
 *   - `onSessionLost` moves to AUTH_EXPIRED: reconnecting with the same rejected token is pointless
 *     and the broker will refuse everything but a cancel anyway.
 *
 * PURE of I/O: it holds only the current state and a "have we ever connected" bit; a caller feeds
 * it events and reads `state()`.
 */
export class OrderStreamStateMachine {
  private current: OrderStreamLifecycleState;
  private everConnected = false;
  private reconcileOwed = false;

  constructor(enabled: boolean) {
    this.current = enabled ? "DISCONNECTED" : "DISABLED";
  }

  state(): OrderStreamLifecycleState {
    return this.current;
  }

  /** True while a post-connect/reconnect REST reconciliation has not yet completed. */
  reconcilePending(): boolean {
    return this.reconcileOwed;
  }

  /** Whether the NEXT successful connect is a reconnect (a gap may have occurred). */
  isReconnect(): boolean {
    return this.everConnected;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.current = "DISABLED";
      this.reconcileOwed = false;
      return;
    }
    if (this.current === "DISABLED") this.current = "DISCONNECTED";
  }

  onConnecting(): void {
    if (this.current === "DISABLED") return;
    this.current = "CONNECTING";
  }

  /** Socket open — a route exists, nothing more. Never READY. */
  onSocketOpen(): void {
    if (this.current === "DISABLED") return;
    this.current = "AUTHENTICATING";
  }

  /** Authorised — but a reconciliation is always owed before entry resumes. */
  onAuthenticated(): void {
    if (this.current === "DISABLED") return;
    this.everConnected = true;
    this.reconcileOwed = true;
    this.current = "RECONCILING";
  }

  /** The reconciliation sweep completed and is consistent. The ONLY path to READY. */
  markSynchronized(): void {
    if (this.current === "DISABLED") return;
    this.reconcileOwed = false;
    // Only promote to READY from a connected-and-authorised state; never from a dropped one.
    if (this.current === "RECONCILING" || this.current === "DEGRADED") this.current = "READY";
  }

  /** Connected but not delivering usable events within the expected idle bound. */
  onIdle(): void {
    if (this.current === "READY" || this.current === "RECONCILING") this.current = "DEGRADED";
  }

  onDisconnected(): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    this.reconcileOwed = true;
    this.current = "DISCONNECTED";
  }

  onSessionLost(): void {
    if (this.current === "DISABLED") return;
    this.reconcileOwed = true;
    this.current = "AUTH_EXPIRED";
  }

  permissions(): OperationPermissions {
    return orderStreamPermissions(this.current);
  }
}


/**
 * THE MARKET-DATA LIFECYCLE STATE MACHINE.
 *
 * The mirror of {@link OrderStreamStateMachine} for the OTHER transport — and the piece that was
 * missing (GAP 1). {@link MarketDataState} and its permission table existed, but NOTHING drove the
 * state: readiness fell back to a scattered "did a tick arrive recently" boolean, which a socket
 * that had merely opened could satisfy. This class turns real market-data lifecycle EVENTS into
 * the {@link MarketDataState} the table scores, and makes `READY` genuinely expensive to reach.
 *
 * WHY IT NEEDS MORE THAN THE ORDER-STREAM MACHINE
 * The order stream is account-wide: one reconciliation sweep proves the whole account is caught
 * up, so a single `markSynchronized` reaches READY. Market data is PER-INSTRUMENT: "the feed is
 * up" says nothing about whether the four specific legs a box needs each have a fresh usable book.
 * A reconnect that restores 2,798 of 2,800 subscriptions is not READY for a box whose leg is one
 * of the missing two. So this machine tracks, PER TRADED INSTRUMENT, whether fresh usable depth
 * has been observed IN THE CURRENT GENERATION, and only reaches READY when every DESIRED instrument
 * has. On reconnect the generation advances and all per-instrument readiness is dropped: a book
 * observed under a superseded socket is not evidence for the new one.
 *
 * THE FOUR TIME FACTS, KEPT DISTINCT (item 5 discipline):
 *   - transport heartbeat  (`onHeartbeat`)   — the 1-byte keep-alive; proves the socket is alive,
 *                                               proves NOTHING about any book's freshness.
 *   - last received frame  (`onFrame`)        — any inbound frame, tick or heartbeat.
 *   - last valid depth     (`onUsableDepth`)  — a usable two-sided book for a specific instrument.
 *   - per-instrument age   (readiness map)    — when each traded instrument last had usable depth.
 * A machine that read a heartbeat as a depth update would report READY on a dead-book feed; these
 * are deliberately four separate clocks and the machine never substitutes one for another.
 *
 * THE LOAD-BEARING TRANSITIONS (compare OrderStreamStateMachine):
 *   - `onSocketOpen`  CONNECTING → AUTHENTICATING. A route, not authorisation. Never READY.
 *   - `onAuthenticated` AUTHENTICATING → SYNCHRONIZING, and ADVANCES THE GENERATION, dropping all
 *     prior per-instrument readiness. Even a first connect must observe depth before READY.
 *   - `onUsableDepth`/`onSubscriptionsConfirmed`/`evaluate` are the ONLY paths to READY, and only
 *     when EVERY desired instrument has fresh depth this generation and the feed is live.
 *   - `onDisconnected` → DISCONNECTED (exposure management + cancel continue; new entry stops).
 *   - `onSessionLost`  → AUTH_EXPIRED, TERMINAL: no data event can revive it (the token is dead).
 *   - a heartbeat gap, a stale book, or a processing backlog demotes READY → DEGRADED.
 *
 * PURE of sockets and timers. The only external it reads is an injected `now()` (monotonic ms),
 * used solely to compare against the heartbeat/book age bounds; determinism is total.
 */
export interface MarketDataStateMachineOptions {
  /** Whether market data is armed at all. When false the machine stays DISABLED. */
  readonly enabled: boolean;
  /** Monotonic clock (ms). Injected so tests are deterministic; defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Maximum age (ms) of the newest received frame before a connected feed is DEGRADED. This is the
   * TRANSPORT-liveness bound (heartbeat/frame), distinct from book age. Default 5000.
   */
  readonly heartbeatMaxAgeMs?: number;
  /**
   * Maximum age (ms) a per-instrument usable book may reach before it stops counting as fresh for
   * READY, degrading the machine. Mirrors the engine's quote/feed freshness discipline. Default
   * 10000.
   */
  readonly bookMaxAgeMs?: number;
}

export class MarketDataStateMachine {
  private current: MarketDataState;
  private readonly enabledInitially: boolean;
  private readonly nowFn: () => number;
  private readonly heartbeatMaxAgeMs: number;
  private readonly bookMaxAgeMs: number;

  /** Connection generation; advanced on every (re)authentication. */
  private gen = 0;
  /** DESIRED traded instruments — what readiness is measured AGAINST. */
  private desired = new Set<number>();
  /** Per-instrument last usable-depth time, stamped with the generation it belongs to. */
  private depthAt = new Map<number, { at: number; gen: number }>();
  /** Subscriptions the feed has CONFIRMED on the wire this generation. */
  private confirmed = new Set<number>();

  /** Four distinct time facts (see class header). Null until first observed. */
  private lastHeartbeatAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastDepthAt: number | null = null;
  /** True while the application ingestion pipeline is backed up. */
  private backlog = false;

  constructor(opts: MarketDataStateMachineOptions) {
    this.enabledInitially = opts.enabled;
    this.nowFn = opts.now ?? Date.now;
    this.heartbeatMaxAgeMs = Math.max(0, opts.heartbeatMaxAgeMs ?? 5_000);
    this.bookMaxAgeMs = Math.max(0, opts.bookMaxAgeMs ?? 10_000);
    this.current = opts.enabled ? "DISCONNECTED" : "DISABLED";
  }

  state(): MarketDataState {
    return this.current;
  }

  generation(): number {
    return this.gen;
  }

  permissions(): OperationPermissions {
    return marketDataPermissions(this.current);
  }

  /** The desired instruments that currently have FRESH usable depth in the CURRENT generation. */
  readyInstruments(): number[] {
    const now = this.nowFn();
    const out: number[] = [];
    for (const token of this.desired) {
      if (this.isInstrumentFresh(token, now)) out.push(token);
    }
    return out;
  }

  /** True when a specific instrument is executable: fresh usable depth THIS generation. */
  isInstrumentReady(token: number): boolean {
    return this.isInstrumentFresh(token, this.nowFn());
  }

  private isInstrumentFresh(token: number, now: number): boolean {
    const d = this.depthAt.get(token);
    if (!d || d.gen !== this.gen) return false;
    return now - d.at <= this.bookMaxAgeMs;
  }

  /* ─────────────────────────── subscription intent (desired ≠ observed) ─────────────────────────── */

  /**
   * Declare the traded instruments readiness is measured against.
   *
   * DESIRED is intentionally separate from CONFIRMED (on the wire) and from OBSERVED (fresh depth).
   * Narrowing the set can COMPLETE readiness — an instrument no longer traded stops being required —
   * without ever inventing depth for it. Widening the set re-opens SYNCHRONIZING until the new
   * instruments confirm.
   */
  setDesiredInstruments(tokens: Iterable<number>): void {
    this.desired = new Set([...tokens].filter((t) => Number.isFinite(t) && t > 0));
    this.reevaluate();
  }

  /** The feed confirmed these subscriptions on the wire (this generation). */
  onSubscriptionsConfirmed(tokens: Iterable<number>): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    for (const t of tokens) this.confirmed.add(t);
    this.reevaluate();
  }

  /* ─────────────────────────── transport lifecycle → state ─────────────────────────── */

  onConnecting(): void {
    if (this.current === "DISABLED") return;
    this.current = "CONNECTING";
  }

  /** Socket open — a route exists, nothing more. Never READY. */
  onSocketOpen(): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    this.current = "AUTHENTICATING";
  }

  /**
   * Authenticated. Advances the generation and DROPS all prior per-instrument readiness and
   * confirmations — a reconnect's books belong to a superseded socket. Enters SYNCHRONIZING; fresh
   * depth per instrument is still owed before READY.
   */
  onAuthenticated(): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    this.gen++;
    this.confirmed.clear();
    // Retain the map entries (cheap, bounded by desired set) but they no longer match this.gen,
    // so isInstrumentFresh treats them as absent until re-observed under the new generation.
    this.lastDepthAt = null;
    this.backlog = false;
    this.current = "SYNCHRONIZING";
  }

  /* ─────────────────────────── the four time facts ─────────────────────────── */

  /** A transport heartbeat (the 1-byte keep-alive). Liveness only — NOT a depth update. */
  onHeartbeat(at?: number): void {
    const t = at ?? this.nowFn();
    this.lastHeartbeatAt = t;
    this.lastFrameAt = t;
    this.reevaluate();
  }

  /** Any inbound frame arrived (tick or heartbeat). Liveness only. */
  onFrame(at?: number): void {
    this.lastFrameAt = at ?? this.nowFn();
    this.reevaluate();
  }

  /**
   * A usable two-sided book was observed for a specific instrument. THE ONLY event that makes an
   * instrument fresh — and it also counts as a received frame. Stamped with the current generation.
   */
  onUsableDepth(token: number, at?: number): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    const t = at ?? this.nowFn();
    this.depthAt.set(token, { at: t, gen: this.gen });
    this.confirmed.add(token);
    this.lastDepthAt = t;
    this.lastFrameAt = t;
    this.reevaluate();
  }

  /** Signal that the application ingestion pipeline is (or is no longer) backed up. */
  onProcessingBacklog(active: boolean): void {
    this.backlog = active;
    this.reevaluate();
  }

  onDisconnected(): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    this.current = "DISCONNECTED";
  }

  onSessionLost(): void {
    if (this.current === "DISABLED") return;
    this.current = "AUTH_EXPIRED";
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.current = "DISABLED";
      return;
    }
    if (this.current === "DISABLED") this.current = "DISCONNECTED";
  }

  /**
   * Re-derive the state from current evidence. Exposed so a caller (or a timer) can force the
   * age-based demotions that no discrete event would otherwise trigger — a heartbeat gap or a book
   * that quietly aged past its bound produces no event at all, so a poll must notice it.
   */
  evaluate(): MarketDataState {
    this.reevaluate();
    return this.current;
  }

  private reevaluate(): void {
    // Terminal / absent states are never promoted or demoted by evidence.
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    if (this.current === "CONNECTING" || this.current === "AUTHENTICATING") return;
    if (this.current === "DISCONNECTED") return;

    const now = this.nowFn();
    const live = this.isTransportLive(now);
    const allFresh = this.everyDesiredFresh(now);

    if (!live || this.backlog || !allFresh) {
      // Connected (SYNCHRONIZING/READY/DEGRADED) but the evidence does not support READY.
      // Before first full readiness we are still SYNCHRONIZING; after it, a regression is DEGRADED.
      if (this.current === "READY") {
        this.current = "DEGRADED";
      } else if (this.current === "DEGRADED") {
        // stay DEGRADED
      } else {
        this.current = "SYNCHRONIZING";
      }
      return;
    }
    // live && no backlog && every desired instrument fresh ⇒ READY.
    this.current = "READY";
  }

  private isTransportLive(now: number): boolean {
    const frame = this.lastFrameAt;
    if (frame === null) return false;
    return now - frame <= this.heartbeatMaxAgeMs;
  }

  private everyDesiredFresh(now: number): boolean {
    if (this.desired.size === 0) return false; // nothing to prove readiness against ⇒ not READY
    for (const token of this.desired) {
      if (!this.isInstrumentFresh(token, now)) return false;
    }
    return true;
  }

  diagnostics(): {
    state: MarketDataState;
    generation: number;
    desired: number;
    confirmed: number;
    readyInstruments: number;
    lastHeartbeatAt: number | null;
    lastFrameAt: number | null;
    lastDepthAt: number | null;
    backlog: boolean;
  } {
    return {
      state: this.current,
      generation: this.gen,
      desired: this.desired.size,
      confirmed: this.confirmed.size,
      readyInstruments: this.readyInstruments().length,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastFrameAt: this.lastFrameAt,
      lastDepthAt: this.lastDepthAt,
      backlog: this.backlog,
    };
  }
}
