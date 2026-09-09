import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

import {
  MAX_FLATTEN_APPLICATION_IDS,
  adoptObservedFlattenCharges,
  compactObservedFlattenChargeWatermarks,
  compactResidualProjectionBookkeeping,
  createResidualProjectionCommand,
  persistOwnedResidualProjection,
  recoveryExecutionAttemptId,
  residualProjectionChanges,
  residualProjectionIdentity,
  runInitialRegisteredResidualPass,
  seedObservedFlattenCharges,
  transitionResidualProjectionSnapshot,
} from "../../dist/box/executionAttemptProjection.js";

// NOTE: the former `real Mongo:` env-gated tests in this file (concurrent projection CAS,
// legacy version-zero CAS, recovery-index establishment, crash-only adoption, and the Mongo
// daily-risk index probe) were removed with the Mongo store. Their SQL equivalents live in
// tests/pg/ (projectionCas.test.mjs, tradesAndRecovery.test.mjs) and the new pg_indexes probe
// above. See tests/README.md for the one-to-one map.
const {
  BOX_RECOVERY_KEY,
  BOX_RECOVERY_UNIQUE_INDEX,
  BoxRecoveryPersistenceGate,
  boxExecutionAttemptDailyRiskContribution,
  boxRecoveryPersistenceValidationError,
  isBoxRecoveryPersistenceReady,
} = await import("../../dist/box/repository.js");

const residual = (quantity = 75, attempt = 1) => [{
  token: 9001,
  tradingsymbol: "SYM-k1_ce",
  exchange: "NFO",
  role: "k1_ce",
  side: "BUY",
  quantity,
  average_price: 100,
  source: "partial_entry",
  created_at: 1_000,
  flatten_attempt: attempt,
}];

class AtomicProjectionStore {
  constructor(snapshot) {
    this.snapshot = structuredClone(snapshot);
  }

  async apply(command) {
    // JavaScript runs this synchronous transition without an await: concurrent callers therefore
    // model an atomic compare-and-set, while their returned promises may settle concurrently.
    const transition = transitionResidualProjectionSnapshot(this.snapshot, command);
    this.snapshot = structuredClone(transition.snapshot);
    await new Promise((resolve) => setImmediate(resolve));
    return transition.result;
  }
}

test("legacy execution-attempt rows start at version zero without a migration", async () => {
  const before = residual(75, 1);
  const after = residual(40, 2);
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: null,
    resolved: false,
    // Deliberately no version, projection identity, or application ledger.
  });
  const command = createResidualProjectionCommand({
    attemptId: "legacy-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: after,
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 12.345,
  });

  const result = await store.apply(command);
  assert.equal(result.status, "applied");
  assert.equal(result.projection_version, 1);
  assert.equal(result.flatten_charges, 12.35);
  assert.equal(result.flatten_charge_day, "2026-09-07");
  assert.equal(result.flatten_charges_for_day, 12.35);
  assert.deepEqual(result.residual_exposure, after);
  assert.equal(store.snapshot.applied_flatten_applications.length, 1);
});

test("no-POST/no-progress passes do not consume projection ownership", async () => {
  const legacy = residual(75, 1).map(({ flatten_attempt: _attempt, ...leg }) => leg);
  const unchanged = residual(75, 1);
  const noOp = createResidualProjectionCommand({
    attemptId: "no-post-attempt",
    expectedVersion: 0,
    expectedResidual: legacy,
    nextResidual: unchanged,
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 0,
  });
  assert.equal(
    residualProjectionChanges(noOp),
    false,
    "legacy missing generation and explicit attempt 1 are the same semantic projection",
  );

  const fill = createResidualProjectionCommand({
    attemptId: "no-post-attempt",
    expectedVersion: 0,
    expectedResidual: legacy,
    nextResidual: residual(25, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9,
  });
  assert.equal(residualProjectionChanges(fill), true);
  const store = new AtomicProjectionStore({ residual_exposure: legacy, flatten_charges: 0, resolved: false });
  if (residualProjectionChanges(noOp)) await store.apply(noOp);
  const result = await store.apply(fill);
  assert.equal(result.status, "applied", "the broker-confirmed fill still owns version zero");
  assert.equal(store.snapshot.flatten_charges, 9);
  assert.deepEqual(store.snapshot.residual_exposure, residual(25, 2));
});

test("two projection writers apply one version and one charge exactly once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "race-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(25, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9.87,
  });
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 1,
    applied_flatten_applications: [],
    resolved: false,
  });

  const results = await Promise.all([store.apply(command), store.apply(command)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["already_applied", "applied"]);
  assert.equal(store.snapshot.projection_version, 1);
  assert.equal(store.snapshot.flatten_charges, 10.87, "the delta is present once, not once per worker");
  assert.deepEqual(store.snapshot.residual_exposure, residual(25, 2));
});

test("a stale writer cannot restore an older quantity or generation", async () => {
  const original = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(original),
    residual_exposure: original,
    flatten_charges: 0,
    applied_flatten_applications: [],
    resolved: false,
  });
  const winner = createResidualProjectionCommand({
    attemptId: "stale-attempt",
    expectedVersion: 0,
    expectedResidual: original,
    nextResidual: residual(20, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 5,
  });
  const stale = createResidualProjectionCommand({
    attemptId: "stale-attempt",
    expectedVersion: 0,
    expectedResidual: original,
    nextResidual: residual(60, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 8,
  });

  assert.equal((await store.apply(winner)).status, "applied");
  const result = await store.apply(stale);
  assert.equal(result.status, "stale");
  assert.equal(result.projection_version, 1);
  assert.deepEqual(result.residual_exposure, residual(20, 3));
  assert.equal(store.snapshot.flatten_charges, 5);
});

test("lost acknowledgement retries the immutable command and converges local risk once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "lost-ack-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(45, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 7.25,
  });
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: 0,
    resolved: false,
  });
  const seen = [];
  let loseAck = true;
  let riskDebit = 0;
  const observedFlattenCharges = new Map();
  const observedFlattenChargesByDay = new Map();
  const persist = async (immutableCommand) => {
    seen.push(structuredClone(immutableCommand));
    const result = await store.apply(immutableCommand);
    if (loseAck) {
      loseAck = false;
      throw new Error("reply lost after atomic commit");
    }
    return result;
  };

  await assert.rejects(() => persistOwnedResidualProjection({
    attemptId: "lost-ack-attempt",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge) => { riskDebit += charge; },
  }), /reply lost/);
  const retry = await persistOwnedResidualProjection({
    attemptId: "lost-ack-attempt",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge) => { riskDebit += charge; },
  });

  assert.equal(retry.status, "already_applied");
  assert.deepEqual(seen[0], seen[1], "pending retry retains quantity, charge, version and application id");
  assert.equal(store.snapshot.flatten_charges, 7.25, "durable charge is exactly once");
  assert.equal(riskDebit, 7.25, "the lost-ack retry observes and debits the durable total once");
});

test("a lost prior-day acknowledgement advances lifetime bookkeeping without debiting today", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "rollover-lost-ack",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: [],
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 8.75,
  });
  const store = new AtomicProjectionStore({
    residual_exposure: before,
    flatten_charges: 0,
    resolved: false,
  });
  const observedFlattenCharges = new Map();
  const observedFlattenChargesByDay = new Map();
  let currentDay = "2026-09-07";
  let currentDayDebit = 0;
  let loseAck = true;
  const persist = async (immutableCommand) => {
    const result = await store.apply(immutableCommand);
    if (loseAck) {
      loseAck = false;
      throw new Error("day-D reply lost after commit");
    }
    return result;
  };
  const apply = () => persistOwnedResidualProjection({
    attemptId: "rollover-lost-ack",
    command,
    persist,
    observedFlattenCharges,
    observedFlattenChargesByDay,
    onAppliedCharge: (charge, observation) => {
      if (observation?.chargeDay === currentDay) currentDayDebit += charge;
    },
  });

  await assert.rejects(apply, /day-D reply lost/);
  currentDay = "2026-09-08";
  const retry = await apply();
  assert.equal(retry.status, "already_applied");
  assert.equal(retry.flatten_charge_day, "2026-09-07");
  assert.equal(retry.flatten_charges_for_day, 8.75);
  assert.equal(observedFlattenCharges.get("rollover-lost-ack"), 8.75,
    "the process lifetime watermark still converges");
  assert.equal(currentDayDebit, 0, "day D's delayed acknowledgement cannot debit day D+1");
  await apply();
  assert.equal(currentDayDebit, 0, "repeated prior-day acknowledgements remain idempotent");
});

test("each process converges to the durable cumulative charge exactly once", async () => {
  const before = residual(75, 1);
  const command = createResidualProjectionCommand({
    attemptId: "risk-owner-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: [],
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 11.5,
  });
  const store = new AtomicProjectionStore({ residual_exposure: before, flatten_charges: 0, resolved: false });
  const workers = [1, 2].map(() => ({ observed: new Map(), observedByDay: new Map(), debited: 0 }));

  const applyFor = (worker) => persistOwnedResidualProjection({
    attemptId: "risk-owner-attempt",
    command,
    persist: (candidate) => store.apply(candidate),
    observedFlattenCharges: worker.observed,
    observedFlattenChargesByDay: worker.observedByDay,
    onAppliedCharge: (charge) => { worker.debited += charge; },
  });
  const results = await Promise.all(workers.map(applyFor));

  assert.deepEqual(results.map((result) => result.status).sort(), ["already_applied", "applied"]);
  assert.deepEqual(workers.map((worker) => worker.debited), [11.5, 11.5],
    "the durable write is once while each process independently converges");
  await Promise.all(workers.map(applyFor));
  assert.deepEqual(workers.map((worker) => worker.debited), [11.5, 11.5],
    "repeated acknowledgements do not double debit either process");
  assert.equal(store.snapshot.flatten_charges, 11.5);
  assert.equal(store.snapshot.resolved, true);
});

test("stale adoption debits only the durable delta above a loaded attempt baseline", async () => {
  const before = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 3,
    applied_flatten_applications: [],
    resolved: false,
  });
  const winner = createResidualProjectionCommand({
    attemptId: "loaded-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(20, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 5,
  });
  const stale = createResidualProjectionCommand({
    attemptId: "loaded-attempt",
    expectedVersion: 0,
    expectedResidual: before,
    nextResidual: residual(60, 2),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 9,
  });
  assert.equal((await store.apply(winner)).status, "applied");

  const observed = new Map();
  const observedByDay = new Map();
  seedObservedFlattenCharges(observed, "loaded-attempt", 3);
  let debited = 0;
  const adopt = () => persistOwnedResidualProjection({
    attemptId: "loaded-attempt",
    command: stale,
    persist: (candidate) => store.apply(candidate),
    observedFlattenCharges: observed,
    observedFlattenChargesByDay: observedByDay,
    onAppliedCharge: (charge) => { debited += charge; },
  });
  assert.equal((await adopt()).status, "stale");
  assert.equal(debited, 5, "historical seed is not debited again");
  assert.equal((await adopt()).status, "stale");
  assert.equal(debited, 5, "the same stale authoritative total is observed once");
});

test("late recovery adoption debits only its persisted current-day bucket", () => {
  const observed = new Map();
  let debited = 0;
  const adopted = adoptObservedFlattenCharges({
    observedByAttempt: observed,
    attemptId: "late-recovery",
    cumulativeCharges: 19,
    currentDay: "2026-09-07",
    chargeDay: "2026-09-07",
    chargesForDay: 4,
    onNewCharge: (charge) => { debited += charge; },
  });
  assert.equal(adopted, 4);
  assert.equal(observed.get("late-recovery"), 19,
    "prior-day cumulative history becomes the watermark, not today's debit");
  assert.equal(debited, 4);
  assert.equal(adoptObservedFlattenCharges({
    observedByAttempt: observed,
    attemptId: "late-recovery",
    cumulativeCharges: 19,
    currentDay: "2026-09-07",
    chargeDay: "2026-09-07",
    chargesForDay: 4,
    onNewCharge: (charge) => { debited += charge; },
  }), 0);
  assert.equal(debited, 4, "re-adoption cannot debit the day bucket twice");
});

test("carryover attempts attribute flatten charges to payment day across restart", async () => {
  const yesterday = new Date("2026-09-06T08:00:00.000Z");
  const todayStart = Date.parse("2026-09-06T18:30:00.000Z");
  assert.equal(boxExecutionAttemptDailyRiskContribution({
    resolved_at: yesterday,
    net_abort_pnl: -20,
    flatten_charges: 105,
    flatten_charge_day: "2026-09-07",
    flatten_charges_for_day: 5,
  }, todayStart, "2026-09-07"), -5,
  "today's restart seed includes the late fee but not yesterday's abort or cumulative fees");

  const before = residual(20, 2);
  const store = new AtomicProjectionStore({
    projection_version: 1,
    residual_projection_identity: residualProjectionIdentity(before),
    residual_exposure: before,
    flatten_charges: 100,
    flatten_charge_day: "2026-09-06",
    flatten_charges_for_day: 100,
    applied_flatten_applications: [],
    resolved: false,
  });
  const firstToday = createResidualProjectionCommand({
    attemptId: "carryover",
    expectedVersion: 1,
    expectedResidual: before,
    nextResidual: residual(10, 3),
    flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 2,
  });
  assert.equal((await store.apply(firstToday)).status, "applied");
  assert.equal(store.snapshot.flatten_charges, 102);
  assert.equal(store.snapshot.flatten_charge_day, "2026-09-07");
  assert.equal(store.snapshot.flatten_charges_for_day, 2,
    "a new day starts a fresh bucket without losing lifetime cumulative charges");
});

test("projection application ids remain bounded while evicted commands are stale", async () => {
  let current = residual(75, 1);
  const store = new AtomicProjectionStore({
    projection_version: 0,
    residual_projection_identity: residualProjectionIdentity(current),
    residual_exposure: current,
    flatten_charges: 0,
    applied_flatten_applications: [],
    resolved: false,
  });
  const commands = [];
  for (let version = 0; version < MAX_FLATTEN_APPLICATION_IDS + 3; version++) {
    const next = residual(Math.max(1, 75 - version - 1), version + 2);
    const command = createResidualProjectionCommand({
      attemptId: "bounded-attempt",
      expectedVersion: version,
      expectedResidual: current,
      nextResidual: next,
      flattenChargeDay: "2026-09-07",
    flattenChargeDelta: 1,
    });
    commands.push(command);
    assert.equal((await store.apply(command)).status, "applied");
    current = next;
  }
  assert.equal(store.snapshot.applied_flatten_applications.length, MAX_FLATTEN_APPLICATION_IDS);
  assert.equal(store.snapshot.flatten_charges, MAX_FLATTEN_APPLICATION_IDS + 3);
  assert.equal((await store.apply(commands.at(-1))).status, "already_applied");
  assert.equal((await store.apply(commands[0])).status, "stale",
    "an evicted id remains harmless because its expected version is old");
  assert.equal(store.snapshot.flatten_charges, MAX_FLATTEN_APPLICATION_IDS + 3);
});

test("resolved watermarks and obsolete day buckets are released while live ones survive", () => {
  const observedByAttempt = new Map([
    ["live", 12.5],
    ["pending", 4],
    ["resolved", 99],
  ]);
  const observedByAttemptDay = new Map([
    ["live\u00002026-09-07", 12.5],
    ["live\u00002026-09-04", 3],
    ["pending\u00002026-09-07", 4],
    ["resolved\u00002026-09-07", 99],
  ]);

  const sizes = compactObservedFlattenChargeWatermarks({
    observedByAttempt,
    observedByAttemptDay,
    // Exactly what the engine retains: exposure still being flattened plus an outstanding
    // acknowledgement. The resolved attempt is represented by the authoritative seed.
    retainAttemptIds: new Set(["live", "pending"]),
    currentDay: "2026-09-07",
  });

  assert.deepEqual([...observedByAttempt.keys()].sort(), ["live", "pending"]);
  assert.deepEqual(
    [...observedByAttemptDay.keys()].sort(),
    ["live\u00002026-09-07", "pending\u00002026-09-07"],
    "a prior-day bucket cannot outlive its rollover",
  );
  assert.deepEqual(sizes, { lifetime: 2, dayBuckets: 2 });
  assert.equal(observedByAttempt.get("live"), 12.5,
    "compaction never lowers a retained watermark, so a repeat acknowledgement stays idempotent");
});

test("projection version/identity bookkeeping is released only for unprojectable attempts", () => {
  const projectionVersionByAttempt = new Map([["live", 7], ["pending", 2], ["resolved", 11]]);
  const projectionIdentityByAttempt = new Map([
    ["live", residualProjectionIdentity(residual(40, 3))],
    ["pending", residualProjectionIdentity(residual(75, 1))],
    ["resolved", residualProjectionIdentity([])],
  ]);

  const sizes = compactResidualProjectionBookkeeping({
    projectionVersionByAttempt,
    projectionIdentityByAttempt,
    retainAttemptIds: new Set(["live", "pending"]),
  });

  assert.deepEqual([...projectionVersionByAttempt.keys()].sort(), ["live", "pending"]);
  assert.deepEqual([...projectionIdentityByAttempt.keys()].sort(), ["live", "pending"]);
  assert.equal(projectionVersionByAttempt.get("live"), 7,
    "a retained attempt keeps the exact expected version its next compare-and-set needs");
  assert.deepEqual(sizes, { projectionVersions: 2, projectionIdentities: 2 });

  // Every attempt resolving leaves nothing behind, which is the bound the audit asked for.
  assert.deepEqual(
    compactResidualProjectionBookkeeping({
      projectionVersionByAttempt,
      projectionIdentityByAttempt,
      retainAttemptIds: new Set(),
    }),
    { projectionVersions: 0, projectionIdentities: 0 },
  );
});

test("direct recovery registers with the watchdog before its first no-progress pass", async () => {
  const events = [];
  const registered = new Map();
  const inFlight = new Set();
  const result = await runInitialRegisteredResidualPass({
    markInFlight: () => { events.push("in-flight"); inFlight.add("recovery"); },
    register: () => { events.push("registered"); registered.set("recovery", residual()); },
    flatten: async () => {
      events.push("flatten");
      assert.equal(registered.has("recovery"), true);
      assert.equal(inFlight.has("recovery"), true);
      return { remaining: residual(), flatten_charges: 0 };
    },
    clearInFlight: () => { events.push("cleared"); inFlight.delete("recovery"); },
  });
  assert.deepEqual(events, ["in-flight", "registered", "flatten", "cleared"]);
  assert.deepEqual(result.remaining, residual());
  assert.equal(registered.has("recovery"), true,
    "no-book/gate-refusal/broker-rejection style no-progress remains autonomously retryable");
  assert.equal(inFlight.size, 0);
});

test("offline recovery-index validation rejects missing, incompatible, and duplicate states", () => {
  const valid = {
    name: BOX_RECOVERY_UNIQUE_INDEX,
    unique: true,
    key: { candidate_key: 1 },
    partialFilterExpression: { candidate_key: BOX_RECOVERY_KEY, resolved: false },
  };
  assert.equal(boxRecoveryPersistenceValidationError([valid], ["one"]), null);
  assert.match(boxRecoveryPersistenceValidationError([], []), /missing/);
  assert.match(boxRecoveryPersistenceValidationError([{ ...valid, unique: false }], []), /not unique/);
  assert.match(boxRecoveryPersistenceValidationError([{
    ...valid,
    partialFilterExpression: { candidate_key: BOX_RECOVERY_KEY, resolved: true },
  }], []), /partial filter/);
  assert.match(boxRecoveryPersistenceValidationError([valid], ["one", "two"]), /duplicate unresolved/);
});

test("projection and crash-recovery identities are deterministic and content-sensitive", () => {
  const a = residual(75, 1);
  const reordered = [
    ...a,
    { ...a[0], token: 9002, tradingsymbol: "SYM-k2_ce", role: "k2_ce" },
  ];
  const reversed = [...reordered].reverse();
  assert.equal(residualProjectionIdentity(reordered), residualProjectionIdentity(reversed));
  assert.equal(
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reordered),
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reversed),
  );
  assert.notEqual(
    recoveryExecutionAttemptId("boot-recovery:2026-09-07", reordered),
    recoveryExecutionAttemptId("boot-recovery:2026-09-08", reordered),
  );
});

/* ══════════ crash-recovery readiness must survive a reconnect ══════════
 *
 * The boundary is verified by a round trip, so it is only trustworthy while THAT connection is up.
 * The bit used to be one-shot — cleared on every disconnect, set only by `boot()`, which cannot run
 * twice — so one routine reconnect quarantined crash-only recovery (and, with such exposure
 * attributed, live entry) until an operator restarted the process.
 */

test("a restored Box connection re-verifies the crash-recovery boundary and lifts the quarantine", async () => {
  let connected = true;
  let nowMs = 0;
  let establishes = 0;
  let fail = false;
  const gate = new BoxRecoveryPersistenceGate({
    isConnected: () => connected,
    establish: async () => {
      establishes++;
      if (fail) throw new Error("index verification unavailable");
    },
    now: () => nowMs,
    reverifyBackoffMs: 1_000,
  });

  // Fail closed before boot — and a readiness PROBE must never establish the safety-critical
  // boundary as a side effect in a process that never established it explicitly.
  assert.equal(gate.isReady(), false);
  assert.equal(establishes, 0);

  await gate.establishNow();
  assert.equal(establishes, 1);
  assert.equal(gate.isReady(), true);

  // A lost connection invalidates the verification: it proved nothing about the next connection.
  connected = false;
  assert.equal(gate.isReady(), false);

  connected = true;
  assert.equal(gate.isReady(), false, "the first probe after a reconnect is still fail-closed");
  assert.equal(gate.isReady(), false);
  assert.equal(gate.isReady(), false);
  assert.equal(establishes, 2, "repeated probes start exactly one re-verification, never a storm");
  await gate.pendingVerification();
  assert.equal(gate.isReady(), true, "the restored connection lifts the quarantine, with no restart");
  assert.equal(establishes, 2);

  // A re-verification that FAILS stays quarantined and is not retried inside the backoff window.
  nowMs = 1_000;
  connected = false;
  fail = true;
  assert.equal(gate.isReady(), false);
  connected = true;
  assert.equal(gate.isReady(), false);
  await gate.pendingVerification();
  assert.equal(establishes, 3);
  assert.equal(gate.isReady(), false, "an unverifiable boundary stays fail-closed");
  await gate.pendingVerification();
  assert.equal(establishes, 3, "and is not retried within the backoff window");

  // The next window recovers on its own.
  nowMs = 2_000;
  fail = false;
  assert.equal(gate.isReady(), false);
  await gate.pendingVerification();
  assert.equal(establishes, 4);
  assert.equal(gate.isReady(), true);
});

test("the module-level readiness probe is fail-closed with no Box connection", () => {
  // The production wiring: no connection offline, so crash-only recovery stays quarantined and
  // nothing tries to build indexes.
  assert.equal(isBoxRecoveryPersistenceReady(), false);
});

/* ══════════ the daily-risk seed must be bounded and indexed ══════════ */

/**
 * REWRITTEN for the PostgreSQL authority.
 *
 * The original asserted on the literal Mongoose query text of the old repository
 * (`.sort()/.limit()/$or`) and on a `boxExecutionAttemptSchema.index(...)` call in the old
 * `model.ts`. Both are gone by design: reservations, CAS and the daily-risk seed are SQL now.
 *
 * The behavioural guarantee is unchanged and is what we pin here:
 *   1. every daily-risk seed read is BOUNDED (LIMIT), never an unbounded scan;
 *   2. each bounded read is ORDERED by an indexed column, so truncation drops the least
 *      significant rows rather than an arbitrary page;
 *   3. overlapping branches are DEDUPLICATED by id, so a day is never charged twice; and
 *   4. the supporting indexes ACTUALLY EXIST — asserted by querying PostgreSQL's own
 *      catalog (`pg_indexes`), which is strictly stronger evidence than matching source text.
 */

const HERE_EAP = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR_EAP = resolve(HERE_EAP, "..", "..", "migrations");
const PG_URL_EAP = (process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge").trim();

test("every daily-risk seed branch is bounded and index-ordered (SQL source)", () => {
  const repository = readFileSync(new URL("../../src/box/repository.ts", import.meta.url), "utf8");
  const seed = repository.slice(
    repository.indexOf("export async function loadBoxLiveRiskSeed"),
    repository.indexOf("/* ----------------------------- daily P&L archive"),
  );

  // (1) No unbounded multi-branch scan: the Mongo `$or` is gone, and every attempt read is bounded.
  assert.equal(seed.includes("$or"), false, "no unbounded multi-branch scan");
  assert.equal(
    (seed.match(/LIMIT \$\d/g) ?? []).length >= 3,
    true,
    "each of the three attempt contributions is bounded by a LIMIT",
  );
  assert.match(seed, /BOX_DAILY_RISK_SEED_LIMIT/, "the bound is the shared explicit limit");

  // (2) Each bound is served in the order that matters, so truncation keeps the significant rows.
  //     day-scoped branch:  WHERE flatten_charge_day = $1  ORDER BY flatten_charges_for_day DESC
  assert.match(
    seed,
    /flatten_charge_day = \$1[\s\S]*?ORDER BY flatten_charges_for_day DESC LIMIT/,
    "the day-scoped branch is ordered by the same-day charge magnitude",
  );
  //     resolved-today branch:  WHERE resolved_at >= $1  ORDER BY resolved_at DESC
  assert.match(
    seed,
    /resolved_at >= \$1[\s\S]*?ORDER BY resolved_at DESC LIMIT/,
    "the resolved-today branch is ordered by resolution time",
  );
  //     still-unresolved branch:  WHERE resolved = false  ORDER BY resolved_at DESC
  assert.match(
    seed,
    /resolved = false[\s\S]*?ORDER BY resolved_at DESC LIMIT/,
    "the still-unresolved branch is ordered by resolution time",
  );

  // (3) Overlapping branches are merged by identity or the day is charged more than once.
  assert.match(seed, /attemptsById\.set\(r\._id, r\)/, "rows are deduplicated by id before summing");
});

test("the daily-risk seed's supporting indexes actually exist in PostgreSQL (pg_indexes)", async () => {
  // A throwaway schema; apply migrations 002 (which defines the attempt table + its indexes),
  // then read the catalog directly. This proves the indexes the seed's ORDER BY relies on are
  // really present — evidence the source-text test could never provide.
  const schema = `eap_idx_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const client = new pg.Client({ connectionString: PG_URL_EAP });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path = ${schema}`);
    for (const file of ["002_box_core.sql"]) {
      await client.query(readFileSync(resolve(MIGRATIONS_DIR_EAP, file), "utf8"));
    }

    const { rows } = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'box_execution_attempts'`,
      [schema],
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    // day-scoped branch: (flatten_charge_day, flatten_charges_for_day DESC)
    const dayIdx = byName.get("box_execution_attempt_flatten_charge_day");
    assert.ok(dayIdx, "the day-scoped seed branch must have a supporting index");
    assert.match(dayIdx, /\(flatten_charge_day, flatten_charges_for_day DESC\)/);

    // resolved-today branch: (resolved_at DESC)
    const resolvedAtIdx = byName.get("box_execution_attempts_resolved_at_idx");
    assert.ok(resolvedAtIdx, "the resolved-today branch must be served by an index");
    assert.match(resolvedAtIdx, /\(resolved_at DESC\)/);

    // still-unresolved branch: (resolved, resolved_at DESC)
    const resolvedIdx = byName.get("box_execution_attempts_resolved_idx");
    assert.ok(resolvedIdx, "the still-unresolved branch must be served by an index");
    assert.match(resolvedIdx, /\(resolved, resolved_at DESC\)/);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end().catch(() => {});
  }
});

