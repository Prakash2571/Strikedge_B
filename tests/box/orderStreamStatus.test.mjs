/**
 * ORDER-UPDATE STREAM STATUS — the anti-conflation surface.
 *
 * Item 6 requires that "a functioning market-data socket must not be mistaken for a
 * functioning order-update stream". These tests assert the status makes that mistake
 * impossible to make from the API surface: the order-stream signal is independent, it names
 * the mechanism actually observing fills, and — critically — an implemented-but-unconsumed
 * stream reports `not_wired` rather than the flattering `disabled`.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { orderStreamStatus } from "../../dist/box/orderStreamStatus.js";

const BOTH = ["zerodha", "dhan"];
const liveHealth = {
  state: "LIVE", connected: true, authorised: true,
  lastEventAt: 1_700_000_000_000, disconnects: 0, reconcilePending: false,
  detail: "Order-update stream live — fills observed here first, REST reconciles.",
};

test("with no consumer, every broker reports not_wired and REST-only fill observation", () => {
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => false });
  assert.equal(s.any_stream_live, false);
  assert.equal(s.brokers.length, 2);
  for (const b of s.brokers) {
    assert.equal(b.wiring, "not_wired");
    assert.equal(b.fills_observed_by, "rest_polling_only");
    assert.equal(b.health, null);
    // The detail must say plainly that nothing consumes it — not merely "disabled".
    assert.match(b.detail, /NO running component is consuming it/);
    assert.match(b.detail, /supervised live validation/);
  }
});

test("an ARMED gate with no consumer is still not_wired — an armed switch delivers no fills", () => {
  // This is the specific lie this module exists to prevent: reporting "armed" because an env
  // var is set, when nothing is listening.
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => true });
  for (const b of s.brokers) {
    assert.equal(b.wiring, "not_wired", "an env gate alone does not start a consumer");
    assert.equal(b.fills_observed_by, "rest_polling_only");
    assert.match(b.detail, /does NOT by itself start a consumer/);
  }
  assert.equal(s.any_stream_live, false);
});

test("a consumer present but gate off reports gated_off, still REST-only", () => {
  const consumers = new Map([["zerodha", liveHealth]]);
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => false, consumers });
  const z = s.brokers.find((b) => b.broker === "zerodha");
  assert.equal(z.wiring, "gated_off");
  assert.equal(z.fills_observed_by, "rest_polling_only", "not armed ⇒ not the fill mechanism");
  assert.equal(z.gate_env_var, "ZERODHA_ORDER_STREAM_ENABLED");
});

test("armed + consumer + LIVE health is the ONLY combination that counts as stream-observed", () => {
  const consumers = new Map([["zerodha", liveHealth]]);
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: (b) => b === "zerodha", consumers });
  const z = s.brokers.find((b) => b.broker === "zerodha");
  const d = s.brokers.find((b) => b.broker === "dhan");
  assert.equal(z.wiring, "armed");
  assert.equal(z.fills_observed_by, "stream_primary_rest_reconcile");
  assert.equal(d.fills_observed_by, "rest_polling_only", "dhan has no consumer");
  assert.equal(s.any_stream_live, true);
});

test("a reconnected-pending-reconcile stream is NOT trusted as the fill mechanism", () => {
  // The gap must be repaired from REST before the stream is believed again, so it must not
  // be reported as the thing observing fills.
  const pending = { ...liveHealth, state: "RECONNECTED_PENDING_RECONCILE", reconcilePending: true };
  const consumers = new Map([["dhan", pending]]);
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => true, consumers });
  const d = s.brokers.find((b) => b.broker === "dhan");
  assert.equal(d.wiring, "armed");
  assert.equal(d.fills_observed_by, "rest_polling_only", "pending reconcile ⇒ REST is authoritative");
  assert.equal(s.any_stream_live, false);
});

test("a disconnected stream falls back to REST-only", () => {
  const down = { ...liveHealth, state: "DOWN", connected: false, authorised: false };
  const consumers = new Map([["dhan", down]]);
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => true, consumers });
  assert.equal(s.brokers.find((b) => b.broker === "dhan").fills_observed_by, "rest_polling_only");
});

test("not_built is distinct from not_wired", () => {
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => false, notBuilt: ["dhan"] });
  assert.equal(s.brokers.find((b) => b.broker === "dhan").wiring, "not_built");
  assert.equal(s.brokers.find((b) => b.broker === "zerodha").wiring, "not_wired");
});

test("the snapshot carries an explicit anti-conflation flag for the UI", () => {
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => false });
  assert.equal(
    s.market_data_health_is_not_order_stream_health,
    true,
    "the UI must be told, in the payload, not to read market-data health as order-stream health",
  );
});

test("no status field can leak a token or account id", () => {
  const consumers = new Map([["zerodha", liveHealth]]);
  const s = orderStreamStatus({ brokers: BOTH, gateEnabled: () => true, consumers });
  const blob = JSON.stringify(s);
  // Only the gate VARIABLE NAMES are permitted; no values, tokens or client ids.
  assert.match(blob, /ZERODHA_ORDER_STREAM_ENABLED/);
  assert.doesNotMatch(blob, /access_token|client_id|dhanClientId|Bearer/i);
});
