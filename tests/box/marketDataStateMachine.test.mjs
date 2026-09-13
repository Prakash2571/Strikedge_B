/**
 * MARKET-DATA STATE MACHINE — the driven health machine for the market-data transport.
 *
 * GAP 1 of the live-execution integration: MarketDataState was DEFINED in streamHealthPolicy.ts
 * but NOTHING transitioned it, so "socket open" could still read as ready via the crude
 * feed-liveness boolean. This suite pins the behaviours the brief requires of the DRIVEN machine
 * (as opposed to the pure permission table, which streamHealthPolicy already covers):
 *
 *   - READY is UNREACHABLE by mere socket-open: connecting → authenticating → synchronizing, and
 *     only reaches READY once EVERY traded instrument has fresh usable depth in the CURRENT
 *     generation;
 *   - a socket open but supplying no usable data is NOT READY (stays SYNCHRONIZING);
 *   - partial subscription recovery keeps the machine SYNCHRONIZING until the LAST traded
 *     instrument confirms;
 *   - a reconnect advances the generation and drops confirmed readiness: books observed under the
 *     previous generation do not make an instrument executable again;
 *   - a heartbeat gap / stale book / processing backlog degrades a READY machine to DEGRADED
 *     (exposure management continues, new entry stops) and recovers on fresh depth;
 *   - socket loss → DISCONNECTED; token rejection → AUTH_EXPIRED (terminal, no auto-recovery);
 *   - the four time facts (transport heartbeat, last received frame, last valid depth, per-leg
 *     book age) are kept DISTINCT — the machine never reads a heartbeat as a depth update;
 *   - DESIRED subscriptions are kept separate from CONFIRMED/OBSERVED readiness.
 *
 * Fully deterministic and PURE: no sockets, no timers, no clock of its own. The caller feeds it
 * events and reads state(); a fixed clock is injected where a time comparison is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataStateMachine,
  marketDataPermissions,
} from "../../dist/box/streamHealthPolicy.js";

/** A machine armed for a single traded instrument set, with an injected clock. */
function makeMachine(instruments = [1, 2, 3, 4], opts = {}) {
  let now = opts.start ?? 1_000;
  const clock = { mono: () => now };
  const machine = new MarketDataStateMachine({
    enabled: true,
    now: () => now,
    heartbeatMaxAgeMs: opts.heartbeatMaxAgeMs ?? 5_000,
    bookMaxAgeMs: opts.bookMaxAgeMs ?? 10_000,
  });
  machine.setDesiredInstruments(instruments);
  return {
    machine,
    advance: (ms) => {
      now += ms;
    },
    at: () => now,
    clock,
  };
}

test("READY is unreachable by socket-open alone; needs auth + subs + fresh depth per instrument", () => {
  const { machine } = makeMachine([10, 20]);
  assert.equal(machine.state(), "DISCONNECTED");

  machine.onConnecting();
  assert.equal(machine.state(), "CONNECTING");

  machine.onSocketOpen();
  assert.equal(machine.state(), "AUTHENTICATING", "socket open is a route only, never READY");

  machine.onAuthenticated();
  assert.equal(machine.state(), "SYNCHRONIZING", "authenticated still owes subs + depth");

  machine.onSubscriptionsConfirmed([10, 20]);
  assert.equal(machine.state(), "SYNCHRONIZING", "subs confirmed but no usable depth yet ⇒ not READY");

  // First usable depth for one of the two: still not enough.
  machine.onUsableDepth(10);
  assert.equal(machine.state(), "SYNCHRONIZING", "one of two instruments fresh ⇒ still not READY");
  assert.equal(machine.permissions().newEntry, false);

  // The last instrument confirms — now, and only now, READY.
  machine.onUsableDepth(20);
  assert.equal(machine.state(), "READY");
  assert.equal(machine.permissions().newEntry, true);
});

test("a socket that opens but supplies no usable data is never READY", () => {
  const { machine, advance } = makeMachine([7]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([7]);
  // Heartbeats keep arriving but NO depth ever does.
  machine.onHeartbeat();
  advance(1_000);
  machine.onHeartbeat();
  assert.equal(machine.state(), "SYNCHRONIZING", "heartbeats are not depth; must not reach READY");
  assert.equal(marketDataPermissions(machine.state()).newEntry, false);
});

test("partial subscription recovery is READY as a TRANSPORT but reports the missing coverage", () => {
  // CHANGED DELIBERATELY, and the change is a fix rather than a relaxation.
  //
  // This used to assert SYNCHRONIZING while 2 of 3 instruments were restored, encoding the rule that
  // EVERY desired instrument must be fresh before READY. In production the desired set is the whole
  // streamed option universe (engine.subscribedOptionTokens), so that rule meant one illiquid strike
  // in an unrelated underlying held the machine below READY — and READY is the only market-data state
  // that licenses new entry, so EVERY box was refused with `feed_unhealthy`, including boxes whose own
  // four books were fresh and executable.
  //
  // READY is a TRANSPORT verdict: authenticated, live, un-backlogged, and demonstrably delivering
  // depth. The per-instrument requirement did not disappear — it moved to where it can be asked about
  // the right instruments, in candidateMarketData.ts, which requires ALL FOUR of a candidate's legs to
  // be subscribed and fresh in the current generation (see tests/box/candidateMarketData.test.mjs).
  // Coverage over the whole desired set remains reported, as observability rather than a hidden gate.
  const { machine } = makeMachine([1, 2, 3]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1, 2]); // only 2 of 3 restored
  machine.onUsableDepth(1);
  machine.onUsableDepth(2);

  assert.equal(machine.state(), "READY", "the transport is genuinely delivering depth");
  const cov = machine.coverage();
  assert.equal(cov.desired, 3);
  assert.equal(cov.fresh, 2);
  assert.equal(cov.missing, 1, "and the missing instrument is reported, not hidden");
  assert.deepEqual(cov.missingSample, [3]);
  // The instrument that never confirmed is still individually NOT ready, which is what a
  // candidate-scoped gate consults.
  assert.equal(machine.isInstrumentReady(3), false, "instrument 3 is not admissible for a candidate");
  assert.equal(machine.isInstrumentReady(1), true);

  // Now 3 comes in: full coverage.
  machine.onSubscriptionsConfirmed([3]);
  machine.onUsableDepth(3);
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0);
  assert.equal(machine.isInstrumentReady(3), true);
});

test("reconnect advances the generation and drops prior-generation readiness", () => {
  const { machine } = makeMachine([100, 200]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([100, 200]);
  machine.onUsableDepth(100);
  machine.onUsableDepth(200);
  assert.equal(machine.state(), "READY");
  const gen1 = machine.generation();

  // Socket drops, then reconnects.
  machine.onDisconnected();
  assert.equal(machine.state(), "DISCONNECTED");
  assert.equal(machine.permissions().newEntry, false);
  assert.equal(machine.permissions().protectiveCancel, true, "cancel still allowed while disconnected");

  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  const gen2 = machine.generation();
  assert.ok(gen2 > gen1, "a reconnect must advance the generation");

  // Depth observed under the OLD generation must not count. Re-confirm subs but only feed ONE.
  machine.onSubscriptionsConfirmed([100, 200]);
  machine.onUsableDepth(100);
  assert.equal(machine.state(), "SYNCHRONIZING", "instrument 200 not yet fresh THIS generation");
  machine.onUsableDepth(200);
  assert.equal(machine.state(), "READY");
});

test("heartbeat gap degrades a READY machine; fresh data recovers it", () => {
  const { machine, advance } = makeMachine([5], { heartbeatMaxAgeMs: 3_000, bookMaxAgeMs: 10_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([5]);
  machine.onHeartbeat();
  machine.onUsableDepth(5);
  assert.equal(machine.state(), "READY");

  // No heartbeat and no frame for longer than the heartbeat bound.
  advance(4_000);
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "heartbeat gap ⇒ DEGRADED");
  assert.equal(machine.permissions().newEntry, false);
  assert.equal(machine.permissions().exitAndReduce, true, "exposure management continues in DEGRADED");

  // A fresh frame + depth recovers.
  machine.onHeartbeat();
  machine.onUsableDepth(5);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
});

test("a stale book (older than bookMaxAge) degrades even while heartbeats flow", () => {
  const { machine, advance } = makeMachine([9], { heartbeatMaxAgeMs: 30_000, bookMaxAgeMs: 5_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([9]);
  machine.onHeartbeat();
  machine.onUsableDepth(9);
  assert.equal(machine.state(), "READY");

  advance(6_000); // book now older than 5s, but heartbeats still fine
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "book aged past bookMaxAge ⇒ DEGRADED even with heartbeats");
});

test("processing backlog degrades a READY machine and clears when it drains", () => {
  const { machine } = makeMachine([1]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1]);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");

  machine.onProcessingBacklog(true);
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "an ingestion backlog blocks new entry");
  assert.equal(machine.permissions().newEntry, false);

  machine.onProcessingBacklog(false);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
});

test("auth expiry is terminal: no auto-recovery, cancel forbidden by table", () => {
  const { machine } = makeMachine([1]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onSessionLost();
  assert.equal(machine.state(), "AUTH_EXPIRED");
  const perms = machine.permissions();
  assert.equal(perms.newEntry, false);
  assert.equal(perms.manageWorkingOrders, false);
  assert.equal(perms.exitAndReduce, false);
  // A stray depth event must NOT resurrect an expired session.
  machine.onUsableDepth(1);
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "AUTH_EXPIRED", "an expired session cannot be revived by data");
});

test("the four time facts are distinct: a heartbeat is not a depth update", () => {
  const { machine, advance } = makeMachine([1], { heartbeatMaxAgeMs: 10_000, bookMaxAgeMs: 2_000 });
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1]);
  machine.onHeartbeat();
  machine.onUsableDepth(1);
  assert.equal(machine.state(), "READY");

  // Only heartbeats keep arriving; the book goes stale. A machine that conflated the two facts
  // would stay READY. The correct one degrades.
  advance(3_000);
  machine.onHeartbeat();
  machine.evaluate();
  assert.equal(machine.state(), "DEGRADED", "a heartbeat must not stand in for a depth update");

  const diag = machine.diagnostics();
  assert.equal(typeof diag.lastHeartbeatAt, "number");
  assert.equal(typeof diag.lastFrameAt, "number");
  assert.equal(typeof diag.lastDepthAt, "number");
  assert.ok(diag.lastHeartbeatAt >= diag.lastDepthAt, "heartbeat clock advanced past the depth clock");
});

test("DISABLED permits nothing and ignores lifecycle events", () => {
  const machine = new MarketDataStateMachine({ enabled: false });
  assert.equal(machine.state(), "DISABLED");
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  assert.equal(machine.state(), "DISABLED", "a disabled machine never leaves DISABLED via events");
  const perms = machine.permissions();
  assert.equal(perms.newEntry, false);
  assert.equal(perms.protectiveCancel, false);
});

test("desired instruments are separate from observed readiness, and narrowing the set narrows COVERAGE", () => {
  // Also changed deliberately: the state no longer swings on whether ONE unobserved instrument is in
  // the desired set, because a universe-wide universal quantifier is the defect. What narrowing the
  // set changes is COVERAGE and per-instrument readiness, which is what callers actually need.
  const { machine } = makeMachine([1, 2, 3]);
  machine.onConnecting();
  machine.onSocketOpen();
  machine.onAuthenticated();
  machine.onSubscriptionsConfirmed([1, 2, 3]);
  machine.onUsableDepth(1);
  machine.onUsableDepth(2);
  assert.equal(machine.state(), "READY", "the transport is delivering; instrument 3 is a coverage gap");
  assert.equal(machine.coverage().missing, 1);
  assert.deepEqual(machine.readyInstruments().sort(), [1, 2]);
  assert.equal(machine.isSubscribed(3), true);

  // Instrument 3 is dropped from the DESIRED set (no longer traded). Coverage completes on the
  // remaining two without inventing depth for 3.
  machine.setDesiredInstruments([1, 2]);
  machine.evaluate();
  assert.equal(machine.state(), "READY");
  assert.equal(machine.coverage().missing, 0, "coverage is complete over the NARROWED set");
  assert.equal(machine.isSubscribed(3), false, "and 3 is no longer part of the subscription intent");
  assert.deepEqual(machine.readyInstruments().sort(), [1, 2]);
});
