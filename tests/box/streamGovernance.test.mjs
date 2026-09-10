/**
 * STREAM GOVERNANCE — the order-stream health machine must actually GOVERN behaviour (D1) and
 * actually be DRIVEN to completion (D4/D5/D6).
 *
 * D1: the combined entry gate must intersect ORDER-STREAM permissions with MARKET-DATA
 * permissions, using the existing combinedPermissions table, and must honour the asymmetry:
 *   - a DISABLED order stream never blocks entry (REST polling is the baseline);
 *   - an ENABLED-but-unhealthy order stream (CONNECTING/AUTHENTICATING/RECONCILING/DEGRADED/
 *     DISCONNECTED/AUTH_EXPIRED) refuses NEW ENTRY;
 *   - EXIT and PROTECTIVE CANCEL are never blocked by the new-entry gate;
 *   - AUTH_EXPIRED is the only order-stream state that refuses protective cancel.
 *
 * Pure, deterministic, no I/O.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  combinedPermissions,
  orderStreamPermissions,
  entryPermittedFromStreams,
} from "../../dist/box/streamHealthPolicy.js";

const ENABLED_UNHEALTHY = [
  "CONNECTING",
  "AUTHENTICATING",
  "RECONCILING",
  "DEGRADED",
  "DISCONNECTED",
  "AUTH_EXPIRED",
];

test("D1: an enabled-but-DISCONNECTED order stream refuses new entry even when market data is READY", () => {
  const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: "DISCONNECTED" });
  assert.equal(gate.permitted, false, "DISCONNECTED order stream must refuse new entry");
});

test("D1: every enabled-but-unhealthy order-stream state refuses new entry when market data is READY", () => {
  for (const os of ENABLED_UNHEALTHY) {
    const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: os });
    assert.equal(gate.permitted, false, `${os} order stream must refuse new entry`);
  }
});

test("D1: a DISABLED order stream does NOT refuse new entry (REST polling is the baseline)", () => {
  const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: "DISABLED" });
  assert.equal(gate.permitted, true, "DISABLED order stream must permit entry when market data is READY");
});

test("D1: READY + READY permits new entry", () => {
  const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: "READY" });
  assert.equal(gate.permitted, true);
});

test("D1: exit and protective cancel are permitted while new entry is refused on a degraded stream", () => {
  // Market data READY (so it does not itself block), order stream DEGRADED.
  const combined = combinedPermissions({ marketData: "READY", orderStream: "DEGRADED" });
  assert.equal(combined.newEntry, false, "new entry refused on degraded stream");
  assert.equal(combined.protectiveCancel, true, "protective cancel still permitted");
  assert.equal(combined.exitAndReduce, true, "exit/reduce still permitted");
});

test("D1: AUTH_EXPIRED refuses protective cancel (broker would refuse anyway) but nothing else does", () => {
  // An EXPIRED SESSION is the one state where a priced protective cancel is refused: the broker
  // rejects a priced order on a dead token, so claiming permission would be a lie, not a safeguard.
  // This is enforced at the SESSION (market-data) transport, whose AUTH_EXPIRED is NONE — and the
  // combined gate (an intersection) therefore refuses a cancel whenever the session is expired.
  assert.equal(
    combinedPermissions({ marketData: "AUTH_EXPIRED", orderStream: "AUTH_EXPIRED" }).protectiveCancel,
    false,
    "an expired session refuses protective cancel (broker would refuse anyway)",
  );
  // EVERY non-expired-session state still permits protective cancel: refusing to reduce exposure
  // because a socket is unhealthy is strictly more dangerous than cancelling.
  for (const md of ["CONNECTING", "AUTHENTICATING", "SYNCHRONIZING", "READY", "DEGRADED", "DISCONNECTED"]) {
    for (const os of ["CONNECTING", "AUTHENTICATING", "RECONCILING", "DEGRADED", "DISCONNECTED", "READY", "DISABLED", "AUTH_EXPIRED"]) {
      assert.equal(
        combinedPermissions({ marketData: md, orderStream: os }).protectiveCancel,
        true,
        `md=${md} os=${os} must still permit protective cancel (session not expired)`,
      );
    }
  }
});

test("D1: gate reports the order-stream state as the refusal reason source", () => {
  const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: "RECONCILING" });
  assert.equal(gate.permitted, false);
  assert.equal(gate.marketData, "READY");
  assert.equal(gate.orderStream, "RECONCILING");
});

/* ═══════════════ D5: idleness detection is driven, and honest ═══════════════ */

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";

function makeClock() {
  let t = 0;
  return { now: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
}

function makeConsumer(clock, { streamEnabled = true, expectedIdleMs = 5000 } = {}) {
  return new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled,
    expectedIdleMs,
    now: () => clock.now(),
  });
}

function bringToReady(consumer) {
  consumer.onConnecting();
  consumer.onSocketOpen();
  consumer.onAuthenticated();
  consumer.markSynchronized();
}

test("D5: an idle-but-connected stream WITH working orders goes DEGRADED", () => {
  const clock = makeClock();
  const consumer = makeConsumer(clock, { expectedIdleMs: 5000 });
  bringToReady(consumer);
  assert.equal(consumer.lifecycleState(), "READY");

  consumer.registerIntent({ clientOrderId: "BOX:T1:ENTRY:k1_ce:a1", ownerTag: "TAG1", account: "AB1234", requestedQty: 75 });

  clock.set(6000);
  consumer.evaluateIdle(clock.now());
  assert.equal(consumer.lifecycleState(), "DEGRADED", "connected but not delivering while a fill is expected");
});

test("D5: an idle stream with NO working orders does NOT go DEGRADED (a quiet account is normal)", () => {
  const clock = makeClock();
  const consumer = makeConsumer(clock, { expectedIdleMs: 5000 });
  bringToReady(consumer);
  assert.equal(consumer.lifecycleState(), "READY");

  clock.set(1_000_000);
  consumer.evaluateIdle(clock.now());
  assert.equal(consumer.lifecycleState(), "READY", "no false alarm on an idle account");
});

test("D5: DEGRADED from idleness feeds the D1 entry gate (new entry refused, cancel/exit still permitted)", () => {
  const clock = makeClock();
  const consumer = makeConsumer(clock, { expectedIdleMs: 5000 });
  bringToReady(consumer);
  consumer.registerIntent({ clientOrderId: "BOX:T1:ENTRY:k1_ce:a1", ownerTag: "TAG1", account: "AB1234", requestedQty: 75 });
  clock.set(6000);
  consumer.evaluateIdle(clock.now());
  assert.equal(consumer.lifecycleState(), "DEGRADED");
  const gate = entryPermittedFromStreams({ marketData: "READY", orderStream: consumer.lifecycleState() });
  assert.equal(gate.permitted, false, "idle DEGRADED refuses new entry");
  const perms = combinedPermissions({ marketData: "READY", orderStream: consumer.lifecycleState() });
  assert.equal(perms.protectiveCancel, true);
  assert.equal(perms.exitAndReduce, true);
});

test("D5: a fill that completes the working order clears the idle expectation (no DEGRADED afterwards)", () => {
  const clock = makeClock();
  const consumer = makeConsumer(clock, { expectedIdleMs: 5000 });
  bringToReady(consumer);
  consumer.registerIntent({ clientOrderId: "BOX:T1:ENTRY:k1_ce:a1", ownerTag: "TAG1", account: "AB1234", requestedQty: 75 });
  consumer.ingestStreamObservation({
    ownerTag: "TAG1", account: "AB1234", cumulativeQty: 75, quantityPresent: true, rawStatus: "COMPLETE", eventId: "e1",
  });
  clock.set(1_000_000);
  consumer.evaluateIdle(clock.now());
  assert.equal(consumer.lifecycleState(), "READY", "a settled order no longer expects events");
});

/* ═══════════════ D4: reconnect drives reconciliation to completion ═══════════════ */

test("D4: a reconnect stays RECONCILING until the explicit sweep reports consistent", async () => {
  const clock = makeClock();
  let sweeps = 0;
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: true,
    now: () => clock.now(),
    reconcileSweep: async () => { sweeps++; },
  });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  assert.equal(consumer.lifecycleState(), "RECONCILING");
  await consumer.runReconnectReconciliation();
  assert.equal(consumer.lifecycleState(), "READY", "initial sync reached READY after the sweep");
  assert.equal(sweeps, 1);

  consumer.onDisconnected();
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  assert.equal(consumer.lifecycleState(), "RECONCILING", "reconnect owes a reconciliation");
  assert.equal(consumer.reconcilePending(), true);

  await consumer.runReconnectReconciliation();
  assert.equal(sweeps, 2, "the reconnect fired a fresh sweep");
  assert.equal(consumer.reconcilePending(), false);
  assert.equal(consumer.lifecycleState(), "READY");
});

test("D4: a fill that occurred during the disconnect gap is recovered by the sweep and counted once", async () => {
  const clock = makeClock();
  const gapFills = new Map();
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: true,
    now: () => clock.now(),
    reconcileSweep: async (ingestRest) => {
      for (const [tag, cum] of gapFills) {
        ingestRest({ ownerTag: tag, account: "AB1234", cumulativeQty: cum, quantityPresent: true, rawStatus: "COMPLETE", eventId: `${tag}:rest:${cum}` });
      }
    },
  });
  consumer.registerIntent({ clientOrderId: "BOX:T1:ENTRY:k1_ce:a1", ownerTag: "TAG1", account: "AB1234", requestedQty: 75 });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  await consumer.runReconnectReconciliation();

  consumer.onDisconnected();
  gapFills.set("TAG1", 75);

  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  await consumer.runReconnectReconciliation();
  assert.equal(consumer.projection().ledger("BOX:T1:ENTRY:k1_ce:a1").cumulative, 75, "gap fill recovered");
  assert.equal(consumer.lifecycleState(), "READY");

  consumer.ingestStreamObservation({ ownerTag: "TAG1", account: "AB1234", cumulativeQty: 75, quantityPresent: true, rawStatus: "COMPLETE", eventId: "TAG1:rest:75" });
  assert.equal(consumer.projection().ledger("BOX:T1:ENTRY:k1_ce:a1").cumulative, 75, "no double count");
});

test("D4: an update arriving DURING reconciliation is merged without double-count and later fills survive", async () => {
  const clock = makeClock();
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: true,
    now: () => clock.now(),
    reconcileSweep: async (ingestRest) => {
      ingestRest({ ownerTag: "TAG1", account: "AB1234", cumulativeQty: 30, quantityPresent: true, rawStatus: "OPEN", eventId: "TAG1:rest:30" });
      consumer.ingestStreamObservation({ ownerTag: "TAG1", account: "AB1234", cumulativeQty: 50, quantityPresent: true, rawStatus: "OPEN", eventId: "TAG1:stream:50" });
    },
  });
  consumer.registerIntent({ clientOrderId: "BOX:T1:ENTRY:k1_ce:a1", ownerTag: "TAG1", account: "AB1234", requestedQty: 75 });
  consumer.onConnecting(); consumer.onSocketOpen(); consumer.onAuthenticated();
  await consumer.runReconnectReconciliation();
  assert.equal(consumer.projection().ledger("BOX:T1:ENTRY:k1_ce:a1").cumulative, 50, "later fill survives, no double count");
  assert.equal(consumer.lifecycleState(), "READY");
});

/* ═══════════════ D6: Zerodha order-stream lifecycle advances from the quote socket ═══════════════ */

test("D6: the Zerodha order-stream health advances past CONNECTING when the quote socket is up", async () => {
  const clock = makeClock();
  let sweeps = 0;
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: true,
    now: () => clock.now(),
    reconcileSweep: async () => { sweeps++; },
  });
  // Before the quote socket connects, the enabled stream is DISCONNECTED (never CONNECTING-stuck).
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");

  // The quote socket carrying the postbacks comes up: this is the ONLY driver for Zerodha.
  await consumer.driveQuoteSocketLifecycle(true);
  // It must NOT be stuck at CONNECTING: the lifecycle walked to RECONCILING then, after the sweep,
  // to READY. This is the exact seam engine.onBoxLaneConnection(true) invokes for Zerodha.
  assert.equal(consumer.lifecycleState(), "READY", "advanced past CONNECTING to READY after the sweep");
  assert.equal(sweeps, 1, "the quote-socket connect drove the reconcile sweep");
});

test("D6: honest in BOTH directions — a quote-socket drop moves the order stream to DISCONNECTED, reconnect re-reconciles", async () => {
  const clock = makeClock();
  let sweeps = 0;
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: true,
    now: () => clock.now(),
    reconcileSweep: async () => { sweeps++; },
  });
  await consumer.driveQuoteSocketLifecycle(true);
  assert.equal(consumer.lifecycleState(), "READY");

  // The quote socket drops: order stream must reflect reality (not overclaim READY).
  await consumer.driveQuoteSocketLifecycle(false);
  assert.equal(consumer.lifecycleState(), "DISCONNECTED");
  // New entry refused; exposure management + cancel continue.
  assert.equal(entryPermittedFromStreams({ marketData: "READY", orderStream: consumer.lifecycleState() }).permitted, false);
  assert.equal(combinedPermissions({ marketData: "READY", orderStream: consumer.lifecycleState() }).protectiveCancel, true);

  // Reconnect drives a fresh reconciliation and returns to READY (not underclaiming once caught up).
  await consumer.driveQuoteSocketLifecycle(true);
  assert.equal(sweeps, 2, "reconnect drove a fresh sweep");
  assert.equal(consumer.lifecycleState(), "READY");
});

test("D6: a DISABLED Zerodha stream is never driven by the quote socket (stays DISABLED, never blocks entry)", async () => {
  const clock = makeClock();
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter: null,
    streamEnabled: false,
    now: () => clock.now(),
  });
  assert.equal(consumer.lifecycleState(), "DISABLED");
  await consumer.driveQuoteSocketLifecycle(true);
  assert.equal(consumer.lifecycleState(), "DISABLED", "a disabled stream is inert; REST polling is the baseline");
  assert.equal(entryPermittedFromStreams({ marketData: "READY", orderStream: consumer.lifecycleState() }).permitted, true);
});
