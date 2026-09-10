/**
 * PERSISTENCE FAILURE AT THE BROKER-MUTATION BOUNDARY (item 12 gap-fill).
 *
 * PostgreSQL is the operational authority. The durable intent journal is written BEFORE the broker
 * POST (CREATED, then SUBMITTING) and AGAIN AFTER the broker reports a fill (the terminal
 * snapshot). Two failure boundaries matter and are tested here through the REAL BoxOrderManager
 * submit path with a fault-injecting persistence and the REAL recording adapter (so a "POST" is a
 * genuine adapter mutation, appended only after the send-boundary callback returns):
 *
 *   BEFORE the mutation — persistence throws while establishing CREATED or SUBMITTING. The order
 *   MUST be rejected and NOTHING may reach the broker. This is the property that stops an entry
 *   from being transmitted that the authority never durably owned: a POST with no durable record
 *   is exactly the unrecoverable, un-attributable exposure the journal exists to prevent.
 *
 *   AFTER the mutation — the broker POST happened and reported a real fill, but persisting that
 *   terminal snapshot throws. The manager MUST NOT report a clean success that hides the fill; it
 *   MUST surface OrderPersistenceAfterFillError, trip the breaker (so no further entry proceeds on
 *   an authority the system can no longer trust), and invoke onPersistenceLossAfterFill with the
 *   real filled quantity. The exposure is loud, not lost.
 *
 * Everything here is the production BoxOrderManager and the production recording adapter from the
 * live-entry harness; only the two genuine process boundaries (broker HTTP, Mongo) are faked, and
 * the Mongo fake fails exactly where the test aims it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxOrderManager, OrderPersistenceAfterFillError } from "../../dist/box/orderManager.js";
import { MemoryPersistence, recordingAdapter, NOW } from "./liveEntryHarness.mjs";

/** A persistence that delegates to the in-memory CAS model but can be told to throw on a phase. */
class FaultyPersistence extends MemoryPersistence {
  constructor() {
    super();
    // "create" | "submitting" | "terminal" | null
    this.failOn = null;
    this.failCount = 0;
  }
  async create(intent) {
    if (this.failOn === "create") {
      this.failCount++;
      throw new Error("PG DOWN: intent CREATE failed before any broker mutation");
    }
    return super.create(intent);
  }
  async update(clientOrderId, patch, audit, expectedStates) {
    // The SUBMITTING transition is BEFORE the POST; a terminal fill snapshot is AFTER it.
    if (this.failOn === "submitting" && patch.state === "SUBMITTING") {
      this.failCount++;
      throw new Error("PG DOWN: SUBMITTING transition failed before any broker mutation");
    }
    if (this.failOn === "terminal" && (patch.filled_quantity ?? 0) > 0) {
      this.failCount++;
      throw new Error("PG DOWN: terminal fill snapshot failed AFTER the broker mutation");
    }
    return super.update(clientOrderId, patch, audit, expectedStates);
  }
}

const LIMITS = {
  maxOpenBoxes: 10,
  maxConcurrentExecutions: 1,
  maxResidualLegs: 10,
  dailyLossLimit: 1_000_000,
  rejectLimit: 100,
  consecutiveFailureLimit: 100,
  maxOpenLegQuantity: 1_000,
  maxGrossOpenLegQuantity: 10_000,
  reconcileIntervalMs: 60_000,
  feedReconnectWarmupMs: 0,
  maxBoxCapitalRupees: 0,
};

function entryRequest(clientOrderId = "BOX:trade-pgfail:ENTRY:k1_ce:a1") {
  return {
    client_order_id: clientOrderId,
    role: "k1_ce",
    trade_id: "trade-pgfail",
    attempt_id: "a1",
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: "SYM-k1_ce",
    token: 1001,
    side: "BUY",
    quantity: 75,
    pricing: { order_type: "LIMIT", reference_price: 100, tick_size: 0.05, max_chase_ticks: 2, limit_price: 100.1 },
  };
}

/** Build the REAL manager over the recording adapter and a fault-injecting persistence. */
function harness({ persistence, onPersistenceLossAfterFill } = {}) {
  const adapter = recordingAdapter();
  let clock = NOW;
  const manager = new BoxOrderManager({
    adapter,
    persistence,
    limits: LIMITS,
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => clock++ },
    istDayKey: () => "2026-09-02",
    ...(onPersistenceLossAfterFill ? { onPersistenceLossAfterFill } : {}),
  });
  manager.seedLimits({ tradingDay: "2026-09-02" });
  manager.setFeedHealthy(true);
  return { manager, adapter, persistence };
}

/* ═══════════════ PG fails BEFORE a broker mutation — no POST ═══════════════ */

test("PostgreSQL fails at CREATE (before the POST): the order is rejected and NOTHING reaches the broker", async () => {
  const persistence = new FaultyPersistence();
  persistence.failOn = "create";
  const h = harness({ persistence });
  await h.manager.reconcile();

  await assert.rejects(
    h.manager.submit(entryRequest()),
    /PG DOWN: intent CREATE failed/,
    "a persistence failure before the mutation must reject the submit",
  );
  assert.equal(persistence.failCount, 1, "the CREATE fault actually fired");
  assert.equal(
    h.adapter.posts.length,
    0,
    "an order the authority never durably recorded must NEVER reach the broker",
  );
  assert.equal(h.manager.status().health.persistence, "unhealthy", "the failure is reported, not hidden");
});

test("PostgreSQL fails at the SUBMITTING transition (still before the POST): no broker mutation", async () => {
  const persistence = new FaultyPersistence();
  persistence.failOn = "submitting";
  const h = harness({ persistence });
  await h.manager.reconcile();

  await assert.rejects(
    h.manager.submit(entryRequest()),
    /SUBMITTING transition failed/,
    "a failed SUBMITTING transition must reject before the POST",
  );
  assert.equal(persistence.failCount, 1, "the SUBMITTING fault actually fired");
  assert.equal(
    h.adapter.posts.length,
    0,
    "SUBMITTING is durable-before-POST; if it cannot be written, the POST must not happen",
  );
  // The CREATED row exists (create succeeded) but the identity never advanced to SUBMITTING.
  const durable = await persistence.findByClientId(entryRequest().client_order_id);
  assert.ok(durable, "the CREATED intent is durable");
  assert.notEqual(durable.state, "SUBMITTING", "the identity never durably entered SUBMITTING");
});

/* ═══════════════ PG fails AFTER a broker mutation — exposure is loud, not lost ═══════════════ */

test("PostgreSQL fails AFTER the fill snapshot: the mutation is not hidden, exposure is surfaced and the breaker trips", async () => {
  const persistence = new FaultyPersistence();
  const lost = [];
  const h = harness({
    persistence,
    onPersistenceLossAfterFill: (order, error) => lost.push({ order, error }),
  });
  await h.manager.reconcile();

  const req = entryRequest();
  // Observe that SUBMITTING was written before we arm the terminal fault, so the test proves the
  // POST really happened between the two persistence phases.
  const original = persistence.update.bind(persistence);
  let submittingWritten = false;
  persistence.update = async (id, patch, audit, expected) => {
    if (patch.state === "SUBMITTING") submittingWritten = true;
    return original(id, patch, audit, expected);
  };
  persistence.failOn = "terminal";

  await assert.rejects(
    h.manager.submit(req),
    (err) => err instanceof OrderPersistenceAfterFillError,
    "an after-fill persistence loss must surface as OrderPersistenceAfterFillError, never a clean success",
  );

  assert.equal(submittingWritten, true, "the order DID reach SUBMITTING (durable-before-POST held)");
  assert.equal(h.adapter.posts.length, 1, "the broker mutation DID happen exactly once — it is real exposure");
  assert.equal(persistence.failCount, 1, "the terminal-snapshot fault fired");

  // The exposure is LOUD: the loss callback carries the real filled quantity, and the breaker trips
  // so no further entry proceeds on an authority the system can no longer trust.
  assert.equal(lost.length, 1, "onPersistenceLossAfterFill was invoked");
  assert.ok(lost[0].order.filled_quantity > 0, "the callback carries the confirmed fill quantity, not a zero");
  const status = h.manager.status();
  assert.equal(status.health.circuit, "open", "the breaker tripped — the system will not keep entering blind");
  assert.equal(status.circuitBreaker.tripped, true, "the breaker is reported tripped");
  assert.equal(status.health.persistence, "unhealthy", "persistence is reported unhealthy after the loss");
});

test("control: with persistence healthy the SAME submit completes cleanly and posts exactly once", async () => {
  const persistence = new FaultyPersistence(); // failOn stays null
  const h = harness({ persistence });
  await h.manager.reconcile();

  const order = await h.manager.submit(entryRequest());
  assert.equal(order.filled_quantity, 75, "the order completed");
  assert.equal(order.state, "COMPLETE");
  assert.equal(h.adapter.posts.length, 1, "exactly one broker mutation");
  assert.equal(h.manager.status().health.persistence, "healthy", "persistence stayed healthy");
  const durable = await persistence.findByClientId(entryRequest().client_order_id);
  assert.equal(durable.state, "COMPLETE");
  assert.equal(durable.filled_quantity, 75);
});
