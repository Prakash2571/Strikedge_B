/**
 * DHAN ORDER-STREAM LIFECYCLE — the connect/reconnect RECONCILIATION defect, and its fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS SUITE EXISTS TO CATCH
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The engine's Dhan branch wired the order feed as:
 *
 *     onConnected: (args) => { consumer.onSocketOpen(); if (args.authorised) consumer.onAuthenticated(); }
 *
 * `onAuthenticated()` ALWAYS owes a reconciliation and lands the lifecycle in RECONCILING;
 * `markSynchronized()` is the ONLY exit. Nothing started a reconciliation, so a Dhan deployment sat
 * in RECONCILING forever, and because `ORDER_STREAM_PERMISSIONS.RECONCILING.newEntry === false` the
 * live entry checkpoint refused every box indefinitely with `feed_unhealthy`. Nothing threw.
 *
 * WHY 2,000 EXISTING TESTS MISSED IT: the only Dhan lifecycle coverage drove the consumer BY HAND
 * (`streamGovernance.test.mjs` calls `runReconnectReconciliation()` itself), so it pinned the
 * consumer's behaviour and never the engine's wiring of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE DRIVES — THE PRODUCTION PATH, NOT A COPY OF IT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   real DhanOrderFeed transport (fake SOCKET only)
 *     → createDhanOrderStreamHandlers()   ← the EXACT handler object engine.ts passes to the factory
 *       → real OrderStreamConsumer → real OrderStreamStateMachine
 *         → real entryPermittedFromStreams()  ← the same gate the live entry checkpoint scores
 *
 * Every test asserts BOTH the lifecycle transition AND the resulting entry permission, because a
 * lifecycle that looks right while the gate still refuses entry is the defect, not the fix.
 *
 * No network, no broker, no database. The socket is a fake; the sweep is an injected callback.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { createDhanOrderStreamHandlers } from "../../dist/box/dhanOrderStreamWiring.js";
import { DhanOrderFeed, DHAN_ORDER_UPDATE_ROOT } from "../../dist/brokers/dhan/orderFeed.js";
import { entryPermittedFromStreams } from "../../dist/box/streamHealthPolicy.js";

/* ─────────────────────────── fakes and helpers ─────────────────────────── */

/** A fake WebSocket the test drives. Mirrors tests/box/orderUpdateStreams.test.mjs. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  message(obj) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

/**
 * Let every already-resolved microtask drain. `onConnected` fires the sweep with `void` (a socket
 * callback must not block on REST), so the lifecycle settles a few microtasks after `open()`.
 */
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Build the PRODUCTION wiring: a real consumer, the real handler factory, and a real DhanOrderFeed
 * whose only fake is the socket. `sweep` is the injected reconciliation the engine supplies from the
 * order manager; here the test controls its verdict so each recovery path is reachable.
 */
function wireDhan({ sweep, streamEnabled = true, now, expectedIdleMs, retryBaseMs = 1_000 } = {}) {
  const sockets = [];
  const sweepCalls = [];
  let clock = 1_000_000;
  const consumer = new OrderStreamConsumer({
    broker: "dhan",
    account: () => "1000000001",
    adapter: null,
    streamEnabled,
    reconcileSweep:
      sweep === undefined
        ? undefined
        : async (ingestRest) => {
            sweepCalls.push(ingestRest);
            return sweep(ingestRest, sweepCalls.length);
          },
    reconcileRetryBaseMs: retryBaseMs,
    reconcileRetryMaxMs: 60_000,
    ...(expectedIdleMs === undefined ? {} : { expectedIdleMs }),
    now: now ?? (() => clock),
  });
  // THE PRODUCTION HANDLERS — the same object engine.startOrderStreamTransports() constructs.
  const handlers = createDhanOrderStreamHandlers(consumer, {
    nowMono: () => clock,
    nowWall: () => clock,
  });
  const feed = new DhanOrderFeed({
    accessToken: () => "JWT-NOT-A-REAL-TOKEN",
    clientId: () => "1000000001",
    ...handlers,
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return {
    consumer,
    feed,
    sockets,
    sweepCalls,
    advance: (ms) => {
      clock += ms;
    },
    nowWall: () => clock,
  };
}

/** The gate the live entry checkpoint actually scores, with market data held READY. */
function entryPermitted(consumer) {
  return entryPermittedFromStreams({
    marketData: "READY",
    orderStream: consumer.lifecycleState(),
  }).permitted;
}

const CONSISTENT = () => ({ synchronized: true, unresolvedOrders: 0, discrepancies: 0 });

/* ═══════════════ 0. REPRODUCTION: the old wiring stranded the stream ═══════════════ */

test("REPRODUCTION: socket-open + authenticate WITHOUT a reconciliation strands RECONCILING and refuses entry forever", async () => {
  // This is EXACTLY what engine.ts used to do in the Dhan branch. No sweep is ever driven.
  const { consumer } = wireDhan({ sweep: async () => CONSISTENT() });
  consumer.onConnecting();
  consumer.onSocketOpen();
  consumer.onAuthenticated("login_submitted");
  await settle();

  assert.equal(consumer.lifecycleState(), "RECONCILING", "the old wiring leaves the lifecycle here");
  assert.equal(
    entryPermitted(consumer),
    false,
    "and RECONCILING refuses new entry — permanently, since nothing will ever call markSynchronized",
  );
  // No amount of waiting helps: there is no driver.
  await settle(50);
  assert.equal(consumer.lifecycleState(), "RECONCILING", "still stranded after further ticks");
});

/* ═══════════════ 1. initial connect, no orders (the idle account) ═══════════════ */

test("initial connect on an account with NO orders reconciles and reaches READY — entry permitted", async () => {
  const { consumer, feed, sockets, sweepCalls } = wireDhan({ sweep: async () => CONSISTENT() });
  feed.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, DHAN_ORDER_UPDATE_ROOT, "the DEDICATED order socket");
  assert.equal(consumer.lifecycleState(), "CONNECTING", "onConnecting drove the machine");

  sockets[0].open();
  // Login submitted per DhanHQ v2 (MsgCode 42, UserType SELF).
  const login = JSON.parse(sockets[0].sent[0]);
  assert.equal(login.LoginReq.MsgCode, 42);
  assert.equal(login.UserType, "SELF");

  await settle();
  assert.equal(sweepCalls.length, 1, "the initial connection drove exactly ONE reconciliation sweep");
  assert.equal(consumer.lifecycleState(), "READY", "a checked, consistent sweep is the only path to READY");
  assert.equal(entryPermitted(consumer), true, "and the entry gate now actually permits new entry");
  feed.dispose();
});

test("an IDLE account becomes READY without any order or trade event ever arriving", async () => {
  // Requirement: a legitimate idle account must not need a first trade/order event to become ready.
  const { consumer, feed, sockets } = wireDhan({ sweep: async () => CONSISTENT() });
  feed.start();
  sockets[0].open();
  await settle();

  assert.equal(consumer.diagnostics().streamEventsApplied, 0, "no order event was delivered at all");
  assert.equal(consumer.lifecycleState(), "READY", "readiness came from the sweep, not from traffic");
  assert.equal(entryPermitted(consumer), true);
  feed.dispose();
});

/* ═══════════════ 2. initial connect with unresolved persisted intent ═══════════════ */

test("initial connect with UNRESOLVED persisted intent: the sweep's recovered fill lands in the ONE projection, then READY", async () => {
  const clientOrderId = "BOX:T7:ENTRY:k1_ce:attempt-1";
  const correlationId = "Bxyz7k1ce";
  const { consumer, feed, sockets } = wireDhan({
    // The sweep recovers the fill that happened before this process was watching, and feeds it
    // through the funnel the consumer supplies — the SAME projection the stream uses, so a later
    // stream redelivery of the same fill deduplicates instead of double-counting.
    sweep: async (ingestRest) => {
      ingestRest({
        ownerTag: correlationId,
        brokerOrderId: "9124",
        account: "1000000001",
        cumulativeQty: 75,
        quantityPresent: true,
        averagePrice: 13.2,
        rawStatus: "TRADED",
        eventId: "9124:rest:75",
      });
      return CONSISTENT();
    },
  });
  // Durable intent registered BEFORE the POST, as production does.
  consumer.registerIntent({ clientOrderId, ownerTag: correlationId, account: "1000000001", requestedQty: 75 });

  feed.start();
  sockets[0].open();
  await settle();

  assert.equal(consumer.lifecycleState(), "READY");
  assert.equal(entryPermitted(consumer), true);
  assert.equal(
    consumer.projection().ledger(clientOrderId).cumulative,
    75,
    "the gap fill was recovered into the durable ledger by the sweep",
  );

  // The stream now redelivers the SAME fill. It must not be counted twice.
  sockets[0].message({
    Type: "order_alert",
    Data: {
      CorrelationId: correlationId,
      OrderNo: "9124",
      ClientId: "1000000001",
      TradedQty: 75,
      AvgTradedPrice: 13.2,
      Status: "TRADED",
      LastUpdatedTime: "2026-09-09 10:00:09",
    },
  });
  assert.equal(
    consumer.projection().ledger(clientOrderId).cumulative,
    75,
    "a stream redelivery of an already-reconciled fill does not double-count",
  );
  feed.dispose();
});

/* ═══════════════ 3. successful reconnect ═══════════════ */

test("a RECONNECT re-owes and re-drives reconciliation, and only then returns to READY", async () => {
  const { consumer, feed, sockets, sweepCalls } = wireDhan({ sweep: async () => CONSISTENT() });
  feed.start();
  sockets[0].open();
  await settle();
  assert.equal(consumer.lifecycleState(), "READY");

  // Non-auth close ⇒ the transport schedules its own reconnect; the lifecycle drops.
  sockets[0].drop(1006);
  assert.equal(consumer.lifecycleState(), "DISCONNECTED", "a drop is a disconnect, never a zero fill");
  assert.equal(entryPermitted(consumer), false, "no new entry while disconnected");
  assert.equal(consumer.reconcilePending(), true, "a gap is owed: the broker does not replay what we missed");

  // The transport reconnects (drive it directly rather than waiting on a real timer).
  feed.start();
  const reconnected = sockets[sockets.length - 1];
  reconnected.open();
  await settle();

  assert.equal(sweepCalls.length, 2, "the reconnect drove its OWN sweep — the first one proves nothing about the gap");
  assert.equal(consumer.lifecycleState(), "READY");
  assert.equal(entryPermitted(consumer), true);
  feed.dispose();
});

/* ═══════════════ 4. reconciliation failure, then a successful retry ═══════════════ */

test("a FAILED sweep leaves entry refused, and the bounded retry later succeeds and reaches READY", async () => {
  let attempt = 0;
  const { consumer, feed, sockets, advance, nowWall } = wireDhan({
    retryBaseMs: 1_000,
    sweep: async () => {
      attempt++;
      if (attempt === 1) throw new Error("broker REST 503");
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  await settle();

  assert.equal(consumer.lifecycleState(), "RECONCILING", "a throwing sweep must NOT promote — fail closed");
  assert.equal(entryPermitted(consumer), false, "entry stays refused while the gap is unproven");
  const diag = consumer.diagnostics();
  assert.match(diag.lastSweepFailure ?? "", /broker REST 503/, "the failure is recorded for the operator");
  assert.equal(diag.sweepAttempts, 1, "one failure counted towards the backoff");

  // BOUNDED BACKOFF: retrying before the delay elapses must not fire another REST call.
  consumer.ensureReconciled(nowWall());
  await settle();
  assert.equal(attempt, 1, "the backoff suppressed an immediate retry — recovery must not flood the rate limit");

  // After the backoff, the poll-safe driver retries and succeeds.
  advance(1_500);
  consumer.ensureReconciled(nowWall());
  await settle();
  assert.equal(attempt, 2, "the retry fired once the bounded delay had elapsed");
  assert.equal(consumer.lifecycleState(), "READY", "recovery completed without needing a reconnect");
  assert.equal(entryPermitted(consumer), true);
  assert.equal(consumer.diagnostics().lastSweepFailure, null, "the failure is cleared once synchronized");
  feed.dispose();
});

/* ═══════════════ 5. disconnect DURING reconciliation ═══════════════ */

test("a disconnect DURING the sweep discards the in-flight result: no promotion of a dead connection", async () => {
  const gate = deferred();
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => {
      await gate.promise;
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  await settle();
  assert.equal(consumer.lifecycleState(), "RECONCILING", "the sweep is still in flight");
  assert.equal(consumer.diagnostics().reconcileInFlight, true);

  // The socket drops while the sweep is running.
  sockets[0].drop(1006);
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");

  // The sweep now resolves CONSISTENT — but for a connection that no longer exists.
  gate.resolve();
  await settle();

  assert.equal(
    consumer.lifecycleState(),
    "DISCONNECTED",
    "a result for a superseded connection must never promote; DISCONNECTED is preserved",
  );
  assert.equal(entryPermitted(consumer), false);
  assert.equal(consumer.reconcilePending(), true, "the reconciliation is still owed");
  assert.equal(consumer.diagnostics().sweepsDiscardedStaleEpoch, 1, "the stale result was explicitly discarded");
  feed.dispose();
});

/* ═══════════════ 6. an OLD sweep finishing after a NEWER connection started ═══════════════ */

test("an OLD sweep resolving AFTER a newer connection authorised does not mark the NEWER connection ready", async () => {
  const first = deferred();
  const second = deferred();
  let call = 0;
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => {
      call++;
      await (call === 1 ? first.promise : second.promise);
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  await settle();
  assert.equal(call, 1, "connection 1's sweep is in flight");

  // Connection 1 dies; connection 2 opens and starts its OWN sweep.
  sockets[0].drop(1006);
  feed.start();
  sockets[sockets.length - 1].open();
  await settle();
  assert.equal(call, 2, "connection 2 drove its own sweep");
  assert.equal(consumer.lifecycleState(), "RECONCILING", "connection 2 is still unproven");

  // Now the OLD sweep finally resolves, claiming consistency.
  first.resolve();
  await settle();
  assert.equal(
    consumer.lifecycleState(),
    "RECONCILING",
    "connection 1's late result must NOT promote connection 2 — it never examined connection 2's gap",
  );
  assert.equal(entryPermitted(consumer), false, "entry still refused: the current connection is unproven");
  assert.ok(consumer.diagnostics().sweepsDiscardedStaleEpoch >= 1, "the stale-epoch result was refused");

  // Connection 2's own sweep completing is what legitimately promotes it.
  second.resolve();
  await settle();
  assert.equal(consumer.lifecycleState(), "READY", "the CURRENT connection's own checked sweep promotes it");
  assert.equal(entryPermitted(consumer), true);
  feed.dispose();
});

/* ═══════════════ 7. duplicate connection callbacks ═══════════════ */

test("DUPLICATE connection callbacks coalesce into ONE sweep and one epoch (bounded work)", async () => {
  const gate = deferred();
  let calls = 0;
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => {
      calls++;
      await gate.promise;
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  const epochAfterFirst = consumer.connectionGeneration();

  // The transport reports the SAME connection again (and the status path polls too).
  const handlers = createDhanOrderStreamHandlers(consumer);
  handlers.onConnected({ authorised: true, reconnect: false });
  handlers.onConnected({ authorised: true, reconnect: false });
  consumer.ensureReconciled();
  await settle();

  assert.equal(calls, 1, "duplicate callbacks did NOT launch duplicate REST sweeps");
  assert.equal(
    consumer.connectionGeneration(),
    epochAfterFirst,
    "a duplicate callback must not advance the epoch, which would strand the sweep already running",
  );

  gate.resolve();
  await settle();
  assert.equal(consumer.lifecycleState(), "READY", "the single coalesced sweep still promotes normally");
  assert.equal(entryPermitted(consumer), true);
  feed.dispose();
});

/* ═══════════════ 8. authentication failure, where observable ═══════════════ */

test("an AUTH close code is AUTH_EXPIRED, not a plain disconnect, and refuses entry", async () => {
  // Dhan publishes no auth acknowledgement, so a rejected login is observable ONLY as a close with
  // an auth code. That is the one authentication failure this protocol lets us see.
  const { consumer, feed, sockets } = wireDhan({ sweep: async () => CONSISTENT() });
  feed.start();
  sockets[0].open();
  await settle();
  assert.equal(consumer.lifecycleState(), "READY");

  sockets[0].drop(4401);
  assert.equal(
    consumer.lifecycleState(),
    "AUTH_EXPIRED",
    "a rejected credential is its own state: reconnecting with it is pointless",
  );
  assert.equal(entryPermitted(consumer), false);
  assert.equal(consumer.reconcilePending(), true);
  feed.dispose();
});

test("authorisation is reported as ASSUMED until a REST round trip establishes it", async () => {
  const gate = deferred();
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => {
      await gate.promise;
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  await settle();

  // Login submitted, socket not rejected — but Dhan acknowledges nothing, so this is an assumption.
  assert.equal(consumer.diagnostics().authEvidence, "login_submitted", "a SEND is not proof of authorisation");
  assert.match(
    consumer.health().detail,
    /ASSUMED, not acknowledged/,
    "the operator-visible detail discloses that authorisation is assumed",
  );
  assert.equal(entryPermitted(consumer), false, "an assumed authorisation never authorises new exposure");

  gate.resolve();
  await settle();
  assert.equal(
    consumer.diagnostics().authEvidence,
    "rest_verified",
    "a successful REST sweep is the positive evidence this protocol cannot give on the socket",
  );
  feed.dispose();
});

/* ═══════════════ 9. a NONEMPTY reconciliation discrepancy result ═══════════════ */

test("a sweep that RESOLVES but reports discrepancies must NOT reach READY (promise resolution is not synchronization)", async () => {
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => ({
      synchronized: false,
      reason: "2 durable order(s) unknown at the broker",
      discrepancies: 2,
      unresolvedOrders: 2,
    }),
  });
  feed.start();
  sockets[0].open();
  await settle();

  assert.equal(
    consumer.lifecycleState(),
    "RECONCILING",
    "the sweep completed without throwing, but what it FOUND was an inconsistent account",
  );
  assert.equal(entryPermitted(consumer), false, "unknown critical evidence must not authorize new exposure");
  const diag = consumer.diagnostics();
  assert.equal(diag.lastSweepDiscrepancies, 2);
  assert.equal(diag.lastSweepUnresolvedOrders, 2);
  assert.match(diag.lastSweepFailure ?? "", /unknown at the broker/);
  assert.match(consumer.health().detail, /Reconciliation is not complete/, "the operator is told why");
  feed.dispose();
});

test("with NO sweep wired at all, the stream stays RECONCILING rather than assuming an empty gap", async () => {
  const { consumer, feed, sockets } = wireDhan({ sweep: undefined });
  feed.start();
  sockets[0].open();
  await settle();

  assert.equal(consumer.lifecycleState(), "RECONCILING", "nothing can prove consistency, so nothing claims it");
  assert.equal(entryPermitted(consumer), false);
  assert.match(consumer.diagnostics().lastSweepFailure ?? "", /no reconciliation sweep is wired/);
  feed.dispose();
});

/* ═══════════════ 10. REST-only operation ═══════════════ */

test("REST-ONLY operation: an intentionally DISABLED stream is not a fault and does not block entry", async () => {
  // Intentionally disabled ≠ unexpectedly broken. With the stream off, REST polling is the declared
  // baseline for observing fills, so the order-stream transport must not veto entry.
  const { consumer, feed, sockets } = wireDhan({ streamEnabled: false, sweep: async () => CONSISTENT() });
  assert.equal(consumer.lifecycleState(), "DISABLED");
  assert.equal(entryPermitted(consumer), true, "REST polling is the baseline; DISABLED does not block");
  assert.match(consumer.health().detail, /REST polling only/);

  // And a DISABLED consumer must not be driven into a lifecycle by transport callbacks.
  feed.start();
  if (sockets.length > 0) sockets[0].open();
  await settle();
  assert.equal(consumer.lifecycleState(), "DISABLED", "a disabled stream stays disabled");
  feed.dispose();
});

test("a BROKEN stream is distinguishable from a DISABLED one: both refuse to claim LIVE, only one blocks entry", async () => {
  const broken = wireDhan({ sweep: async () => CONSISTENT() });
  broken.feed.start();
  broken.sockets[0].open();
  await settle();
  broken.sockets[0].drop(1006);
  assert.equal(broken.consumer.lifecycleState(), "DISCONNECTED");
  assert.equal(entryPermitted(broken.consumer), false, "unexpectedly broken ⇒ no new entry");
  assert.equal(broken.consumer.health().state, "DOWN");

  const disabled = wireDhan({ streamEnabled: false, sweep: async () => CONSISTENT() });
  assert.equal(disabled.consumer.lifecycleState(), "DISABLED");
  assert.equal(entryPermitted(disabled.consumer), true, "intentionally disabled ⇒ REST baseline, entry allowed");
  assert.equal(disabled.consumer.health().state, "DISABLED");
  broken.feed.dispose();
  disabled.feed.dispose();
});

/* ═══════════════ 11. the targeted single-order reconcile is not an account-wide claim ═══════════════ */

test("a TARGETED single-order reconcile must not promote the whole stream to READY", async () => {
  // The old engine wiring had `restReconcile` call `consumer.markSynchronized()`, so resolving ONE
  // order's missing quantity promoted the entire account to READY — an account-wide readiness claim
  // from single-order evidence, and the back door that masked the missing sweep.
  const gate = deferred();
  const { consumer, feed, sockets } = wireDhan({
    sweep: async () => {
      await gate.promise;
      return CONSISTENT();
    },
  });
  feed.start();
  sockets[0].open();
  await settle();
  assert.equal(consumer.lifecycleState(), "RECONCILING");

  // What the fixed engine callback now does for a targeted reconcile: record session evidence only.
  consumer.noteRestVerifiedSession();
  await settle();

  assert.equal(
    consumer.lifecycleState(),
    "RECONCILING",
    "session evidence is not gap evidence: only the checked account-wide sweep may promote",
  );
  assert.equal(entryPermitted(consumer), false);
  assert.equal(consumer.diagnostics().authEvidence, "rest_verified", "but the session IS now established");

  gate.resolve();
  await settle();
  assert.equal(consumer.lifecycleState(), "READY");
  feed.dispose();
});

/* ═══════════════ 12. an explicit markSynchronized for a stale epoch is refused ═══════════════ */

test("markSynchronized for a superseded epoch is refused and reports that it did not apply", async () => {
  const { consumer, feed, sockets } = wireDhan({ sweep: async () => CONSISTENT() });
  feed.start();
  sockets[0].open();
  await settle();
  const staleEpoch = consumer.connectionGeneration();

  sockets[0].drop(1006);
  assert.notEqual(consumer.connectionGeneration(), staleEpoch, "the drop ended the epoch");

  assert.equal(
    consumer.markSynchronized(staleEpoch),
    false,
    "a claim scoped to a dead epoch is refused and says so",
  );
  assert.equal(consumer.lifecycleState(), "DISCONNECTED", "and it changed nothing");
  assert.equal(consumer.reconcilePending(), true, "the reconciliation is still owed");
  feed.dispose();
});
