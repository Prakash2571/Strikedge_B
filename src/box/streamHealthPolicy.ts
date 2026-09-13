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

/**
 * HOW STRONGLY THE STREAM SESSION'S AUTHORISATION IS ACTUALLY ESTABLISHED.
 *
 * Deliberately separate from {@link OrderStreamLifecycleState}, because "we sent credentials" and
 * "the broker confirmed the credentials" are different facts and only one of them is evidence.
 *
 *  - `none`              — nothing has been submitted, or the session has since been dropped/lost.
 *  - `login_submitted`   — the login frame was written to the socket and has not (yet) been
 *                          rejected. This is ALL that Dhan's order-update socket can support: it
 *                          publishes no authentication acknowledgement, so a rejected login surfaces
 *                          only later, as a close with an auth code. It is an ASSUMPTION, not proof,
 *                          and on its own it must never authorise new exposure.
 *  - `broker_acknowledged` — the protocol delivered a positive authentication response.
 *  - `rest_verified`     — a REST call on the SAME session succeeded. This is genuine positive proof
 *                          that the credentials are live, and it is how a Dhan stream's authorisation
 *                          becomes established: the reconciliation sweep is that REST call.
 *
 * Ordered weakest → strongest by {@link strongerAuthEvidence}; evidence is never silently downgraded
 * within a connection epoch, and is reset to `none` when the epoch ends.
 */
export type OrderStreamAuthEvidence =
  | "none"
  | "login_submitted"
  | "broker_acknowledged"
  | "rest_verified";

const AUTH_EVIDENCE_RANK: Readonly<Record<OrderStreamAuthEvidence, number>> = {
  none: 0,
  login_submitted: 1,
  broker_acknowledged: 2,
  rest_verified: 3,
};

/** Keep the strongest of two evidence readings. Never downgrades within an epoch. */
export function strongerAuthEvidence(
  a: OrderStreamAuthEvidence,
  b: OrderStreamAuthEvidence,
): OrderStreamAuthEvidence {
  return AUTH_EVIDENCE_RANK[b] > AUTH_EVIDENCE_RANK[a] ? b : a;
}

/**
 * Whether this evidence, ON ITS OWN, may be treated as an authorised session for the purpose of
 * authorising NEW exposure. `login_submitted` deliberately does not qualify: an unacknowledged login
 * is an assumption. It does not block entry by itself (the lifecycle state does that) — it exists so
 * that a surface which claims "authorised" cannot be built on a send.
 */
export function authEvidenceEstablishesSession(evidence: OrderStreamAuthEvidence): boolean {
  return evidence === "broker_acknowledged" || evidence === "rest_verified";
}

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
  /**
   * CONNECTION GENERATION (epoch). Advanced on every event that changes the IDENTITY or VALIDITY of
   * the underlying session: a new authorisation, a disconnect, a lost session, and a disable. It
   * exists so a reconciliation sweep that was started under connection N and resolves LATE — after
   * a drop, or after connection N+1 has already been established — cannot mark the NEWER connection
   * synchronized. `markSynchronized` takes the generation the sweep was started under and refuses to
   * apply when it no longer matches. Without this, a slow sweep from a superseded socket promotes a
   * connection whose gap it never examined, which is a fabricated readiness claim.
   *
   * This mirrors the generation discipline the market-data machine already uses per instrument.
   */
  private gen = 0;
  /**
   * HOW WELL THE SESSION BEHIND THIS STREAM IS ACTUALLY KNOWN TO BE AUTHORISED.
   *
   * Sending a login frame is NOT evidence that the login was accepted. Dhan's order-update socket
   * publishes no authentication acknowledgement at all (verified against the current DhanHQ v2
   * documentation — see docs/BROKER_STREAM_DOCS.md), so for Dhan the only thing the transport can
   * honestly report on open is `login_submitted`. Positive proof arrives out-of-band, when a REST
   * call on the SAME session succeeds — which is exactly what the reconciliation sweep is. Keeping
   * this distinct from the lifecycle state means the operator-facing surface can say "assumed, not
   * acknowledged" instead of silently implying the broker agreed.
   */
  private authEvidence: OrderStreamAuthEvidence = "none";

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

  /**
   * The current connection epoch. A caller starting asynchronous work that may only be applied to
   * THIS connection captures this first and passes it back to {@link markSynchronized}.
   */
  generation(): number {
    return this.gen;
  }

  /** What is actually known about this session's authorisation. Never upgraded by a mere send. */
  authenticationEvidence(): OrderStreamAuthEvidence {
    return this.authEvidence;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      // Intentionally disabled is NOT broken. The epoch advances so any sweep in flight for the
      // previously-enabled stream cannot land after the stream has been switched off.
      this.gen++;
      this.current = "DISABLED";
      this.reconcileOwed = false;
      this.authEvidence = "none";
      return;
    }
    if (this.current === "DISABLED") this.current = "DISCONNECTED";
  }

  onConnecting(): void {
    if (this.current === "DISABLED") return;
    // Do not REGRESS a connection that is already established. A duplicate "connecting" report for a
    // live socket would otherwise throw away readiness (and re-owe a reconciliation) for a connection
    // that never actually dropped. A genuinely new connection always passes through
    // onDisconnected/onSessionLost first, so this guard cannot hide a real reconnect.
    if (this.isEstablished()) return;
    this.current = "CONNECTING";
  }

  /** Socket open — a route exists, nothing more. Never READY. */
  onSocketOpen(): void {
    if (this.current === "DISABLED") return;
    if (this.isEstablished()) return;
    this.current = "AUTHENTICATING";
  }

  /**
   * Whether this connection has already progressed past authentication, so its epoch has been
   * allocated and its reconciliation is either owed or already proven.
   */
  private isEstablished(): boolean {
    return this.current === "RECONCILING" || this.current === "READY" || this.current === "DEGRADED";
  }

  /**
   * The login frame has been SUBMITTED and, as far as the transport can tell, the session is usable.
   * A reconciliation is always owed before entry resumes — on a first connect as much as a reconnect.
   *
   * `evidence` records how strong that "as far as the transport can tell" actually is. It defaults to
   * `login_submitted`, the honest answer for a protocol with no auth acknowledgement: we sent
   * credentials and the socket has not yet rejected them. Only a broker acknowledgement or a
   * successful REST call on the same session upgrades it, and neither is inferred from a send.
   *
   * IDEMPOTENT PER EPOCH. A transport that fires duplicate connection callbacks (Dhan's `onopen` can
   * be followed by another `onConnected` for the same socket) must not advance the epoch twice and
   * must not re-owe a reconciliation that is already owed and already in flight. So a repeat call
   * while already RECONCILING in the same epoch is a no-op.
   */
  onAuthenticated(evidence: OrderStreamAuthEvidence = "login_submitted"): void {
    if (this.current === "DISABLED") return;
    if (this.isEstablished()) {
      // DUPLICATE CONNECTION CALLBACK for a connection whose epoch is already allocated. Keep the
      // strongest evidence seen, but change nothing else:
      //   - advancing the generation would invalidate the sweep already running for THIS connection,
      //     stranding the machine in RECONCILING with nothing left to promote it;
      //   - re-owing a reconciliation would drop readiness for a connection that never dropped.
      // A genuinely new connection reaches here only after onDisconnected/onSessionLost, which reset
      // the state, so no real reconnect is swallowed by this branch.
      this.authEvidence = strongerAuthEvidence(this.authEvidence, evidence);
      return;
    }
    this.everConnected = true;
    this.reconcileOwed = true;
    this.authEvidence = evidence;
    this.gen++;
    this.current = "RECONCILING";
  }

  /**
   * Record positive, out-of-band proof that the session behind this stream is genuinely authorised —
   * a REST call on the same credentials succeeded. This never changes the lifecycle state on its
   * own (a working REST session says nothing about whether the SOCKET is delivering); it only
   * upgrades what we may honestly claim about authorisation.
   */
  noteRestVerifiedSession(): void {
    if (this.current === "DISABLED") return;
    this.authEvidence = strongerAuthEvidence(this.authEvidence, "rest_verified");
  }

  /**
   * The reconciliation sweep completed AND its result was checked and found consistent. The ONLY
   * path to READY.
   *
   * `atGeneration`, when supplied, is the epoch the sweep was started under. If the epoch has moved
   * on — the socket dropped, the session was lost, the stream was disabled, or a newer connection
   * authorised — the result describes a connection that no longer exists and is DISCARDED: it
   * neither promotes nor clears the owed reconciliation. Returns whether the result was applied, so
   * a caller can tell "synchronized" from "too late to matter".
   */
  markSynchronized(atGeneration?: number): boolean {
    if (this.current === "DISABLED") return false;
    if (atGeneration !== undefined && atGeneration !== this.gen) return false;
    this.reconcileOwed = false;
    // A completed sweep is a successful REST round trip on this session, so authorisation is now
    // positively established rather than merely assumed.
    this.authEvidence = strongerAuthEvidence(this.authEvidence, "rest_verified");
    // Only promote to READY from a connected-and-authorised state; never from a dropped one.
    if (this.current === "RECONCILING" || this.current === "DEGRADED") this.current = "READY";
    return true;
  }

  /** Connected but not delivering usable events within the expected idle bound. */
  onIdle(): void {
    if (this.current === "READY" || this.current === "RECONCILING") this.current = "DEGRADED";
  }

  onDisconnected(): void {
    if (this.current === "DISABLED" || this.current === "AUTH_EXPIRED") return;
    // The epoch ends here: a sweep still in flight for the connection that just dropped must not be
    // allowed to promote whatever connection comes next.
    this.gen++;
    this.reconcileOwed = true;
    this.authEvidence = "none";
    this.current = "DISCONNECTED";
  }

  onSessionLost(): void {
    if (this.current === "DISABLED") return;
    this.gen++;
    this.reconcileOwed = true;
    this.authEvidence = "none";
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
    /*
     * READY IS A TRANSPORT VERDICT, NOT A UNIVERSE-WIDE ONE.
     *
     * This used to require `everyDesiredFresh(now)` — EVERY desired instrument fresh. The engine
     * supplies `subscribedOptionTokens` as the desired set: the entire streamed option universe,
     * every leg of every ATM±3 window across every streaming underlying. READY is the only
     * market-data state whose permission licenses new entry, so ONE illiquid strike in an unrelated
     * underlying that never ticked held the whole machine below READY and the live entry checkpoint
     * refused EVERY box with `feed_unhealthy` — including boxes whose own four books were fresh,
     * executable and same-generation.
     *
     * The universal quantifier was answering the wrong question. "Is the feed healthy?" and "does
     * THIS candidate have admissible evidence?" are different questions with different scopes, and
     * only the second one may be allowed to depend on a specific instrument.
     *
     * So READY now means what its name says and what the permission table needs it to mean: the
     * session is authenticated, the transport is live, ingestion is not backlogged, and the depth
     * pipeline is genuinely delivering — evidenced by at least one desired instrument having fresh
     * usable depth in the CURRENT generation. That last clause is what keeps this honest: a socket
     * that is open and heart-beating but delivering no depth at all is NOT ready, so the case the
     * original code was defending against (a reconnect that restored the socket but not the data) is
     * still caught.
     *
     * WHAT REPLACED THE PER-INSTRUMENT STRICTNESS. It moved to where it belongs, scoped to the
     * candidate being admitted: `candidateMarketData.ts` requires ALL FOUR of a candidate's legs to
     * have fresh usable depth in the current generation, plus subscription coverage, executable-side
     * price and depth, coherence, lot/tick conformance and expiry — and it treats a transport-level
     * failure as a SHARED failure that blocks regardless of how fresh the cached books look. The net
     * effect for the candidate actually being entered is stricter, not weaker; what changed is that
     * an unrelated instrument no longer votes.
     *
     * Coverage over the whole desired set is still tracked and still published — as the
     * observability figure it always was (see `coverage()`), not as a hidden global gate.
     */
    const delivering = this.anyDesiredFresh(now);

    if (!live || this.backlog || !delivering) {
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
    // live && no backlog && the depth pipeline is genuinely delivering ⇒ READY.
    this.current = "READY";
  }

  private isTransportLive(now: number): boolean {
    const frame = this.lastFrameAt;
    if (frame === null) return false;
    return now - frame <= this.heartbeatMaxAgeMs;
  }

  /**
   * Is the depth pipeline actually DELIVERING in this generation?
   *
   * An existential, not a universal: at least one desired instrument must have fresh usable depth.
   * That is enough to prove the end-to-end path works right now (socket → parse → book → freshness),
   * which is the only thing a TRANSPORT verdict can honestly claim. Whether a PARTICULAR instrument
   * is usable is a per-candidate question, answered per candidate in `candidateMarketData.ts`.
   *
   * `desired.size === 0` still yields false: with nothing subscribed there is no evidence the
   * pipeline works at all, so claiming READY would be claiming readiness from silence.
   */
  private anyDesiredFresh(now: number): boolean {
    if (this.desired.size === 0) return false; // nothing to prove readiness against ⇒ not READY
    for (const token of this.desired) {
      if (this.isInstrumentFresh(token, now)) return true;
    }
    return false;
  }

  /**
   * SUBSCRIPTION / SCANNER COVERAGE — how much of the desired universe currently has fresh depth.
   *
   * This is the figure that tells an operator "the scanner is running blind on N instruments". It is
   * reported accurately and is deliberately NOT a gate: gating entry on it is what made one unrelated
   * stale strike refuse every box. `missingSample` is bounded so a universe-sized set cannot produce
   * an unbounded diagnostic payload.
   */
  coverage(sampleLimit = 10): {
    desired: number;
    fresh: number;
    missing: number;
    missingSample: number[];
  } {
    const now = this.nowFn();
    const missingSample: number[] = [];
    let fresh = 0;
    for (const token of this.desired) {
      if (this.isInstrumentFresh(token, now)) {
        fresh++;
      } else if (missingSample.length < Math.max(0, sampleLimit)) {
        missingSample.push(token);
      }
    }
    return { desired: this.desired.size, fresh, missing: this.desired.size - fresh, missingSample };
  }

  /** Whether an instrument is in the current subscription intent. Used by candidate admission. */
  isSubscribed(token: number): boolean {
    return this.desired.has(token);
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
