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
