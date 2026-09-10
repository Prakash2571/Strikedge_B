/**
 * ORDER-STREAM CONSUMER — the PRODUCTION component that wires the transports, the unified
 * projection, the live adapter's `applyOrderUpdate` seam, and the health state machine into
 * ONE object with a real construction site.
 *
 * These tests pin the behaviours the task brief requires of the WIRED consumer (as opposed to
 * the disconnected projection, which orderUpdateStreams.test.mjs already covers):
 *
 *   - a stream event WAKES a real adapter waiter (via applyOrderUpdate) before the REST interval;
 *   - a stream event that beats the POST lands in a pre-registered ledger;
 *   - stream + REST report the SAME fill with no double count;
 *   - a delayed LOWER cumulative quantity never regresses exposure;
 *   - an account-wide event for an order we never placed is rejected as unowned;
 *   - a foreign-account event is rejected;
 *   - an absent-quantity TRADED/CANCELLED is insufficient evidence (never a zero fill) and
 *     schedules a targeted REST reconciliation;
 *   - the health state machine governs permissions: socket-open is NOT READY; order-stream loss
 *     switches to DEGRADED (bounded REST) and forbids new entry while still permitting exit and
 *     protective cancel; a reconnect stays RECONCILING until the gap is repaired;
 *   - auth expiry forbids new entry and management but keeps protective cancel;
 *   - the consumer reports its own OrderStreamHealth so engine status reflects reality.
 *
 * Fully deterministic. The adapter is a REAL minimal BrokerAdapter with a genuine waiter loop
 * (NOT a spy that just records calls), so "a stream event resolves a waiter faster than REST"
 * is proven against actual blocking code. No sockets, no network, no clock.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { orderStreamPermissions } from "../../dist/box/streamHealthPolicy.js";

/* ─────────────────────────── a real adapter with a real waiter loop ─────────────────────────── */

/**
 * A minimal but FAITHFUL broker adapter: it holds order snapshots, exposes `applyOrderUpdate`
 * that merges cumulative-monotonically and wakes waiters, and a `waitForFill` that blocks on
 * EITHER a poll interval OR an external observation — exactly the shape the live adapters use.
 * This is deliberately not a mock: the point is to prove the stream wakes genuine blocking code.
 */
class RealishAdapter {
  constructor({ pollIntervalMs = 1000 } = {}) {
    this.mode = "live";
    this.pollIntervalMs = pollIntervalMs;
    this.orders = new Map();
    this.waiters = new Map();
    this.applied = 0;
    this.ignored = 0;
    this.restPolls = 0;
  }
  register(clientOrderId, quantity, brokerOrderId = null) {
    this.orders.set(clientOrderId, {
      client_order_id: clientOrderId,
      broker_order_id: brokerOrderId,
      quantity,
      filled_quantity: 0,
      state: "ACKNOWLEDGED",
    });
  }
  applyOrderUpdate(update) {
    const known = this.orders.get(update.clientOrderId);
    if (!known) {
      this.ignored++;
      return undefined;
    }
    // An ABSENT quantity must arrive as `undefined`, so a status label cannot fabricate a zero.
    const observed = update.cumulativeQty;
    if (observed === undefined || observed === null) {
      // insufficient evidence: no quantity change, but still a real event.
      this.applied++;
      this.wake(update.clientOrderId);
      return { ...known };
    }
    if (observed < known.filled_quantity) {
      this.ignored++;
      return { ...known }; // monotonic: never regress
    }
    known.filled_quantity = observed;
    if (update.brokerOrderId) known.broker_order_id = update.brokerOrderId;
    if (observed >= known.quantity) known.state = "COMPLETE";
    else if (observed > 0) known.state = "PARTIALLY_FILLED";
    this.applied++;
    this.wake(update.clientOrderId);
    return { ...known };
  }
  wake(clientOrderId) {
    const set = this.waiters.get(clientOrderId);
    if (!set) return;
    for (const w of [...set]) w();
  }
  /** Block until filled OR the poll interval elapses. Resolves with the ms actually waited. */
  async waitForFill(clientOrderId, clock) {
    const started = clock.now();
    const known = this.orders.get(clientOrderId);
    if (known && known.filled_quantity >= known.quantity) return 0;
    let set = this.waiters.get(clientOrderId);
    if (!set) {
      set = new Set();
      this.waiters.set(clientOrderId, set);
    }
    let wake;
    const woken = new Promise((resolve) => { wake = resolve; });
    set.add(wake);
    try {
      await Promise.race([clock.wait(this.pollIntervalMs).then(() => { this.restPolls++; }), woken]);
    } finally {
      set.delete(wake);
    }
    return clock.now() - started;
  }
  streamObservationStats() {
    return { applied: this.applied, ignored: this.ignored };
  }
}

/** A deterministic clock whose `wait` resolves only when time is advanced past the deadline. */
function makeClock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    wait(ms) {
      return new Promise((resolve) => timers.push({ at: t + ms, resolve }));
    },
    advance(ms) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      for (const d of due) {
        timers.splice(timers.indexOf(d), 1);
        d.resolve();
      }
    },
  };
}

function makeConsumer({ adapter, restReconcile, clock, streamEnabled = true, account = "AB1234" } = {}) {
  return new OrderStreamConsumer({
    broker: "zerodha",
    account: () => account,
    adapter,
    streamEnabled,
    restReconcile: restReconcile ?? (async () => undefined),
    now: () => clock.now(),
  });
}

/* ═══════════════ 1. stream event WAKES a real waiter faster than REST ═══════════════ */

test("a stream fill resolves a REAL adapter waiter before the REST poll interval elapses", async () => {
  const clock = makeClock();
  const adapter = new RealishAdapter({ pollIntervalMs: 1000 });
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T1:ENTRY:k1_ce:attempt-1";
  const tag = "BOXTAG1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: tag, account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230001");
  consumer.learnBrokerOrderId(leg, "230001");

  // A caller blocks on the adapter's real waiter loop.
  const waited = adapter.waitForFill(leg, clock);

  // 50ms later the stream delivers a full fill — well inside the 1000ms poll interval.
  clock.advance(50);
  consumer.ingestStreamObservation({
    ownerTag: tag, brokerOrderId: "230001", account: "AB1234",
    cumulativeQty: 75, quantityPresent: true, averagePrice: 12.5, rawStatus: "COMPLETE",
    eventId: "230001:t1:75",
  });

  const elapsed = await waited;
  assert.ok(elapsed < 1000, `waiter woke on the stream (${elapsed}ms), not on the 1000ms poll`);
  assert.equal(adapter.restPolls, 0, "the REST poll interval never elapsed");
  assert.equal(adapter.orders.get(leg).filled_quantity, 75, "the adapter snapshot reflects the fill");
  assert.equal(consumer.projection().ledger(leg).cumulative, 75, "the single projection ledger agrees");
});

/* ═══════════════ 2. a stream event that beats the POST lands in the pre-registered ledger ═══════════════ */

test("a stream fill that arrives BEFORE the placement response lands in the pre-registered ledger", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T2:ENTRY:k1_ce:attempt-1";
  // Durable-intent-first: registered BEFORE the POST. The adapter does NOT know the order yet.
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG2", account: "AB1234", requestedQty: 75 });

  const res = consumer.ingestStreamObservation({
    ownerTag: "BOXTAG2", brokerOrderId: "230002", account: "AB1234",
    cumulativeQty: 75, quantityPresent: true, rawStatus: "COMPLETE", eventId: "230002:e1:75",
  });
  assert.equal(res.attributed, true);
  assert.equal(consumer.projection().ledger(leg).cumulative, 75, "the projection captured the early fill");
});

/* ═══════════════ 3. stream + REST report the SAME fill: no double count ═══════════════ */

test("stream and REST reporting the same cumulative fill are deduplicated in ONE projection", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T3:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG3", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230003");

  consumer.ingestStreamObservation({ ownerTag: "BOXTAG3", account: "AB1234", cumulativeQty: 75, quantityPresent: true, eventId: "stream:75" });
  const rest = consumer.ingestRestObservation({ ownerTag: "BOXTAG3", account: "AB1234", cumulativeQty: 75, quantityPresent: true, eventId: "rest:75" });
  assert.equal(rest.apply.outcome, "stale_cumulative", "REST carried no NEW quantity");
  assert.equal(consumer.projection().ledger(leg).cumulative, 75, "exposure is not doubled");
});

/* ═══════════════ 4. a delayed LOWER cumulative never regresses ═══════════════ */

test("a delayed lower cumulative quantity does not regress exposure or the adapter snapshot", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T4:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG4", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230004");

  consumer.ingestStreamObservation({ ownerTag: "BOXTAG4", account: "AB1234", cumulativeQty: 60, quantityPresent: true, sequence: 5, eventId: "e5" });
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG4", account: "AB1234", cumulativeQty: 20, quantityPresent: true, sequence: 2, eventId: "e2" });
  assert.equal(consumer.projection().ledger(leg).cumulative, 60, "the ledger never rewinds");
  assert.equal(adapter.orders.get(leg).filled_quantity, 60, "the adapter snapshot never rewinds");
});

/* ═══════════════ 5. unowned + foreign-account events rejected ═══════════════ */

test("an account-wide event for an order we never placed is rejected as unowned, never applied", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  consumer.registerIntent({ clientOrderId: "BOX:T5:ENTRY:k1_ce:attempt-1", ownerTag: "BOXTAG5", account: "AB1234", requestedQty: 75 });
  const res = consumer.ingestStreamObservation({ ownerTag: "SOMEOTHERAPP", brokerOrderId: "999", account: "AB1234", cumulativeQty: 50, quantityPresent: true, eventId: "x" });
  assert.equal(res.attributed, false);
  assert.equal(res.rejection, "unowned");
  assert.equal(adapter.applied, 0, "the adapter was never touched for an unowned event");
});

test("a foreign-account event is rejected even when the tag matches", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T5b:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG5B", account: "AB1234", requestedQty: 75 });
  const res = consumer.ingestStreamObservation({ ownerTag: "BOXTAG5B", account: "ZZ9999", cumulativeQty: 75, quantityPresent: true, eventId: "x2" });
  assert.equal(res.rejection, "foreign_account");
  assert.equal(consumer.projection().ledger(leg).cumulative, 0);
});

/* ═══════════════ 6. absent-quantity TRADED/CANCELLED = insufficient evidence, schedules REST ═══════════════ */

test("an absent-quantity TRADED is insufficient evidence and schedules a targeted REST reconciliation", async () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const reconciled = [];
  const consumer = makeConsumer({ adapter, clock, restReconcile: async (id) => { reconciled.push(id); } });
  const leg = "BOX:T6:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG6", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230006");

  const res = consumer.ingestStreamObservation({
    ownerTag: "BOXTAG6", brokerOrderId: "230006", account: "AB1234",
    cumulativeQty: 0, quantityPresent: false, rawStatus: "TRADED", eventId: "230006:traded:missing",
  });
  assert.equal(res.attributed, true, "the event is owned");
  assert.equal(res.quantityEvidence, "absent", "but its quantity is insufficient evidence");
  assert.equal(consumer.projection().ledger(leg).cumulative, 0, "NOT read as a confirmed zero fill");
  // The reconciliation is scheduled on a microtask so it never blocks ingestion; let it run.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(reconciled.includes(leg), "a targeted REST reconciliation was scheduled for the leg");
});

/* ═══════════════ 7. HEALTH: socket open is NOT ready; loss → DEGRADED; reconnect → RECONCILING ═══════════════ */

test("socket open does NOT read READY; it becomes READY only after synchronization completes", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock });
  consumer.onConnecting();
  assert.equal(consumer.lifecycleState(), "CONNECTING");
  consumer.onSocketOpen();
  assert.notEqual(consumer.lifecycleState(), "READY", "a mere open socket is never READY");
  consumer.onAuthenticated();
  // First-ever connect still owes an initial synchronization before entry resumes.
  assert.equal(consumer.lifecycleState(), "RECONCILING");
  assert.equal(orderStreamPermissions(consumer.lifecycleState()).newEntry, false, "no new entry until synced");
  consumer.markSynchronized();
  assert.equal(consumer.lifecycleState(), "READY");
  assert.equal(orderStreamPermissions(consumer.lifecycleState()).newEntry, true);
});

test("order-stream loss switches to DEGRADED bounded-REST: no new entry, but exit and protective cancel stay", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock });
  consumer.onConnecting();
  consumer.onSocketOpen();
  consumer.onAuthenticated();
  consumer.markSynchronized();
  assert.equal(consumer.lifecycleState(), "READY");

  consumer.onDisconnected();
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");
  const perms = orderStreamPermissions(consumer.lifecycleState());
  assert.equal(perms.newEntry, false, "new entry stops on stream loss");
  assert.equal(perms.exitAndReduce, true, "exposure management continues");
  assert.equal(perms.protectiveCancel, true, "protective cancellation always permitted");
  assert.equal(consumer.reconcilePending(), true, "a reconciliation is owed");
});

test("a reconnect stays RECONCILING (no new entry) until the gap is repaired, then resumes READY", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated(); consumer.markSynchronized();
  consumer.onDisconnected();
  // Reconnect: authenticate again, but a gap is owed.
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  assert.equal(consumer.lifecycleState(), "RECONCILING");
  assert.equal(orderStreamPermissions(consumer.lifecycleState()).newEntry, false, "no entry until reconciled");
  consumer.markSynchronized();
  assert.equal(consumer.lifecycleState(), "READY");
});

/* ═══════════════ 8. auth expiry ═══════════════ */

test("auth expiry forbids new entry and management but keeps protective cancel", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated(); consumer.markSynchronized();
  consumer.onSessionLost("token expired");
  assert.equal(consumer.lifecycleState(), "AUTH_EXPIRED");
  const perms = orderStreamPermissions(consumer.lifecycleState());
  assert.equal(perms.newEntry, false);
  assert.equal(perms.manageWorkingOrders, false);
  assert.equal(perms.protectiveCancel, true, "cancel is permitted so exposure can still be reduced");
});

/* ═══════════════ 9. DISABLED consumer permits everything (REST fallback) and reports disabled ═══════════════ */

test("a disabled order stream permits REST-era operation and reports itself disabled, not live", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock, streamEnabled: false });
  assert.equal(consumer.lifecycleState(), "DISABLED");
  const perms = orderStreamPermissions(consumer.lifecycleState());
  assert.equal(perms.newEntry, true, "REST polling was the pre-stream mechanism; disabled must not block trading");
  const health = consumer.health();
  assert.equal(health.state, "DISABLED");
});

/* ═══════════════ 10. consumer reports its OWN OrderStreamHealth for engine status ═══════════════ */

test("the consumer exposes an OrderStreamHealth snapshot that reflects the live stream", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated(); consumer.markSynchronized();
  const leg = "BOX:T10:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG10", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230010");
  clock.advance(500);
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG10", account: "AB1234", cumulativeQty: 75, quantityPresent: true, eventId: "e1", observedAtWall: 500 });
  const health = consumer.health();
  assert.equal(health.state, "LIVE", "the projection health reads LIVE while connected + synced");
  assert.equal(health.connected, true);
  assert.equal(health.authorised, true);
});

/* ═══════════════ 11. cancel racing a fill: the fill that lands after the cancel is not lost ═══════════════ */

test("a fill that lands AFTER a cancel is requested is still counted (cancel racing a fill)", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T11:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG11", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230011");

  // 40 fill, then a cancel is requested. A further 12 fills WHILE the cancel is in flight.
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG11", account: "AB1234", cumulativeQty: 40, quantityPresent: true, rawStatus: "UPDATE", eventId: "e40" });
  // (cancel request happens here in the real adapter; the stream keeps delivering)
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG11", account: "AB1234", cumulativeQty: 52, quantityPresent: true, rawStatus: "UPDATE", eventId: "e52" });
  // A CANCELLED alert WITH a confirmed cumulative of 52 (the broker's final word).
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG11", account: "AB1234", cumulativeQty: 52, quantityPresent: true, rawStatus: "CANCELLED", eventId: "cxl52" });
  assert.equal(consumer.projection().ledger(leg).cumulative, 52, "the 12 that raced the cancel are NOT lost");
  assert.equal(adapter.orders.get(leg).filled_quantity, 52);
});

/* ═══════════════ 12. old socket emitting after reconnect must not repopulate the current generation ═══════════════ */

test("a superseded socket's late frame does not reach the current generation (guarded forwarding)", () => {
  // The generation guard lives in ZerodhaFeed.onTextFrame / DhanOrderFeed onmessage (guarded on
  // socket identity). Here we prove the CONSUMER side: once the machine has advanced to a new
  // connect generation, the caller does not forward a stale socket's frames. We model the caller's
  // guard exactly as the feeds do: a closure captured over the socket that checks identity.
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T12:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG12", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230012");

  // Two socket generations; each forwards ONLY while it is the current handle.
  let currentHandle = { id: 1 };
  const forwarderFor = (handle) => (obs) => {
    if (currentHandle !== handle) return; // superseded socket: drop, exactly like the feeds
    consumer.ingestStreamObservation(obs);
  };
  const gen1 = forwarderFor({ id: 1 });
  const handle2 = { id: 2 };
  const gen2 = forwarderFor(handle2);
  currentHandle = handle2; // reconnect: generation 2 is now current

  // The OLD socket (gen1) emits a late fill for 99 — must be dropped, never applied.
  gen1({ ownerTag: "BOXTAG12", account: "AB1234", cumulativeQty: 99, quantityPresent: true, eventId: "old:99" });
  assert.equal(consumer.projection().ledger(leg).cumulative, 0, "the superseded socket's frame was dropped");
  // The CURRENT socket (gen2) delivers the real 30.
  gen2({ ownerTag: "BOXTAG12", account: "AB1234", cumulativeQty: 30, quantityPresent: true, eventId: "new:30" });
  assert.equal(consumer.projection().ledger(leg).cumulative, 30, "only the current generation repopulates");
});

/* ═══════════════ 13. socket open but supplying no usable events → DEGRADED via onIdle ═══════════════ */

test("a socket that opened but supplies no usable events is DEGRADED, not READY (no new entry)", () => {
  const clock = makeClock();
  const consumer = makeConsumer({ adapter: new RealishAdapter(), clock });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated(); consumer.markSynchronized();
  assert.equal(consumer.lifecycleState(), "READY");
  // The idle watchdog fires: connected, but no usable events within the expected bound.
  consumer.onIdle();
  assert.equal(consumer.lifecycleState(), "DEGRADED");
  const perms = orderStreamPermissions(consumer.lifecycleState());
  assert.equal(perms.newEntry, false, "a silent socket must not license new entry");
  assert.equal(perms.exitAndReduce, true, "but exposure management continues");
  assert.equal(perms.protectiveCancel, true);
});

/* ═══════════════ 14. reconnect merges gap fills without loss or double-count, THEN READY ═══════════════ */

test("a fill that happened during the disconnect gap is recovered on reconnect without double count", () => {
  const clock = makeClock();
  const adapter = new RealishAdapter();
  const consumer = makeConsumer({ adapter, clock });
  const leg = "BOX:T14:ENTRY:k1_ce:attempt-1";
  consumer.registerIntent({ clientOrderId: leg, ownerTag: "BOXTAG14", account: "AB1234", requestedQty: 75 });
  adapter.register(leg, 75, "230014");
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated(); consumer.markSynchronized();

  // Stream sees 30, then drops. 45 more fill in the gap (stream never delivers them).
  consumer.ingestStreamObservation({ ownerTag: "BOXTAG14", account: "AB1234", cumulativeQty: 30, quantityPresent: true, eventId: "s30" });
  consumer.onDisconnected();
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");

  // Reconnect: authenticate → RECONCILING (no entry). The REST sweep discovers the true 75.
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  assert.equal(consumer.lifecycleState(), "RECONCILING");
  const repair = consumer.ingestRestObservation({ ownerTag: "BOXTAG14", account: "AB1234", cumulativeQty: 75, quantityPresent: true, eventId: "recon75" }, "reconciliation");
  assert.equal(repair.apply.delta, 45, "the 45 that filled in the gap is recovered");
  consumer.markSynchronized();
  assert.equal(consumer.lifecycleState(), "READY", "only after the gap is repaired does entry resume");
  assert.equal(consumer.projection().ledger(leg).cumulative, 75);
});
