/**
 * PROVE THE MODULES ARE FED, NOT MERELY PRESENT.
 *
 * A module that is built, unit-tested and never called reports empty forever while looking
 * finished. That is what these tests exist to catch: each one asserts a production CALL SITE exists
 * and that the module produces a non-empty result once real data flows through it.
 *
 * Written after an audit found ten such modules inert.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyOrderProfile } from "../../dist/box/orderPricing.js";
import { ExecutionOutcomeStore } from "../../dist/box/executionOutcomes.js";
import { QueueCalibrationEstimator } from "../../dist/box/queueCalibration.js";
import { BrokerTimingStore } from "../../dist/box/brokerTimingStore.js";
import { buildParityReports } from "../../dist/box/parityReport.js";

const src = (f) => readFileSync(new URL(`../../src/box/${f}`, import.meta.url), "utf8");
/** Strip comments so a mention in prose never counts as a call site. */
const code = (f) =>
  src(f)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

/* ─────────────── production call sites must exist ─────────────── */

test("classifyOrderProfile is CALLED in the fill path, not just defined", () => {
  const leg = code("legExecutor.ts");
  assert.ok(leg.includes("classifyOrderProfile("), "the leg executor must classify against a book");
  // And the result must actually be stored on the order, not computed and dropped.
  assert.ok(leg.includes("order_type: classified.profile"), "the classification must reach the order");
  assert.ok(leg.includes("limit_offset_ticks = classified.offsetTicks"));
});

test("recordOutcome is CALLED, so outcome rates have a numerator", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("this.outcomeStore.recordOutcome("), "nothing recorded outcomes before");
  // Both a success and a failure path must feed it, or the rates are structurally skewed.
  // Matched on the call prefix, not the whole expression: these calls also carry the
  // detected gross edge for cost attribution, and pinning the exact argument list
  // made this assertion break on an unrelated (and correct) signature change.
  assert.ok(engine.includes("this.observeAttempt(legging, false"), "abort path must be observed");
  assert.ok(engine.includes("this.observeAttempt(args.legging, true"), "success path must be observed");
});

test("the queue estimator is FED, not only read", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("this.queueEstimator.record("), "the estimator had no data source before");
  assert.ok(engine.includes("this.queueEstimator.recommendAll()"), "and is still surfaced");
});

test("implementation shortfall is COMPUTED in production", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("computeExecutionShortfall("));
  assert.ok(engine.includes("last_implementation_shortfall"), "and surfaced in diagnostics");
});

test("the parity report has BOTH halves produced", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("buildParityReports("), "the report had no production caller before");
  assert.ok(engine.includes("this.paperTiming.recordLegTiming("), "the PAPER half must be produced");
  assert.ok(engine.includes("this.paperTiming.recordBoxOutcome("));
  // Live and paper must be separate stores, or the report compares a distribution with itself.
  assert.ok(engine.includes("this.brokerTiming.snapshot()") && engine.includes("this.paperTiming.snapshot()"));
});

test("queue evidence is captured from a real observed book, before it is consumed", () => {
  const leg = code("legExecutor.ts");
  assert.ok(leg.includes("leg.executable_within_limit_at_arrival === null"), "captured once");
  assert.ok(
    leg.indexOf("executable_within_limit_at_arrival =") < leg.indexOf("if (walk.filled_qty <= 0)"),
    "must be captured BEFORE any quantity is consumed, or the denominator is already depleted",
  );
});

/* ─────────────── and the modules produce real output when fed ─────────────── */

test("outcome rates become non-zero once outcomes are recorded", () => {
  const store = new ExecutionOutcomeStore();
  assert.equal(store.outcomeCounts("zerodha", "MARKETABLE_LIMIT").total, 0, "empty before");
  for (let i = 0; i < 3; i++) store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "filled_4_of_4");
  store.recordOutcome("zerodha", "MARKETABLE_LIMIT", "partial");
  const counts = store.outcomeCounts("zerodha", "MARKETABLE_LIMIT");
  assert.equal(counts.total, 4);
  assert.equal(counts.rates.filled_4_of_4, 0.75);
});

test("the queue estimator produces a recommendation once fed real observations", () => {
  const est = new QueueCalibrationEstimator({ currentHaircutPct: 30, minSamples: 10 });
  assert.equal(est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL").recommendedHaircutPct, null);
  for (let i = 0; i < 20; i++) {
    est.record({
      broker: "zerodha",
      profile: "MARKETABLE_LIMIT",
      side: "BUY",
      tradingsymbol: "SYM",
      displayedQtyAtSubmit: 300,
      executableWithinLimitAtSubmit: 150,
      requestedQty: 75,
      limitOffsetTicks: 2,
      immediatelyMarketable: true,
      filledQty: 60,
      fillLatencyMs: 120,
      partial: true,
      bookUpdatesWhileWorking: null,
      atWall: 1_700_000_000_000,
    });
  }
  const r = est.recommend("zerodha", "MARKETABLE_LIMIT", "NORMAL");
  assert.equal(r.samples, 20);
  assert.ok(r.recommendedHaircutPct !== null, "with evidence it must recommend something");
  assert.ok(r.realisationRatioP50 < 1, "60 of 75 wanted is a partial realisation");
});

test("a parity report compares two independently-populated stores", () => {
  const live = new BrokerTimingStore({ now: () => 1_000 });
  const paper = new BrokerTimingStore({ now: () => 1_000 });
  const timing = (over) => ({
    broker: "zerodha",
    trade_id: "t",
    attempt_id: "a",
    role: "k1_ce",
    purpose: "ENTRY",
    kind: "ENTRY",
    detected_at: 0,
    queued_at: 0,
    dequeued_at: 0,
    post_started_at: 0,
    post_returned_at: null,
    acknowledged_at: 100,
    first_fill_at: 200,
    last_fill_at: 200,
    terminal_at: 250,
    cancel_requested_at: null,
    cancel_confirmed_at: null,
    ...over,
  });
  for (let i = 0; i < 5; i++) live.recordLegTiming(timing({ acknowledged_at: 300 }));
  for (let i = 0; i < 5; i++) paper.recordLegTiming(timing({ acknowledged_at: 100 }));

  const reports = buildParityReports(live.snapshot(), paper.snapshot());
  const zerodha = reports.find((r) => r.broker === "zerodha");
  assert.ok(zerodha, "a report must exist for a populated broker");
  const ack = zerodha.metrics.find((m) => m.metric === "submit_to_ack_ms");
  assert.ok(ack, "the compared metric must be present on both sides");
  assert.equal(ack.live.p50, 300);
  assert.equal(ack.paper.p50, 100);
  assert.ok(ack.error_pct.p50 < 0, "paper being faster than live must show as a negative error");
  // Five samples justifies nothing, and the report must say so.
  assert.equal(ack.low_confidence, true);
  assert.equal(zerodha.overall_low_confidence, true);
});

test("the classifier really distinguishes the two profiles from a book", () => {
  const bids = [{ price: 99.9, qty: 100, orders: 1 }];
  const asks = [{ price: 100, qty: 100, orders: 1 }];
  // A BUY willing to pay the ask crosses: marketable.
  const marketable = classifyOrderProfile({ side: "BUY", limitPrice: 100.1, bids, asks, tickSize: 0.05 });
  assert.equal(marketable.profile, "MARKETABLE_LIMIT");
  assert.equal(marketable.assumed, false, "decided from the book, not assumed");
  assert.ok(marketable.offsetTicks > 0, "through the touch");
  // A BUY priced below the ask rests behind unknown queue depth: passive.
  const passive = classifyOrderProfile({ side: "BUY", limitPrice: 99.5, bids, asks, tickSize: 0.05 });
  assert.equal(passive.profile, "PASSIVE_LIMIT");
  assert.ok(passive.offsetTicks < 0, "behind the touch");
});

/* ─────────── what remains inert must stay HONESTLY documented ─────────── */

test("modules that are still not wired are documented as such", () => {
  const doc = readFileSync(new URL("../../src/box/LIVE_EXECUTION.md", import.meta.url), "utf8");
  // Each of these has no production call site; the docs must not imply otherwise.
  for (const claim of [
    /fault injection itself is NOT yet plumbed/,
    /UNREACHABLE BY CONSTRUCTION/,
    /no production producer yet/,
  ]) {
    assert.match(doc, claim, "an unwired capability must be labelled, not implied");
  }
});

test("nothing that IS wired is still labelled unwired", () => {
  const doc = readFileSync(new URL("../../src/box/LIVE_EXECUTION.md", import.meta.url), "utf8");
  // The parity report now has both halves; the stale "no production caller" note must be gone.
  assert.doesNotMatch(
    doc,
    /parityReport[^.]*no production caller/i,
    "the parity report is wired now, so the doc must not still say it is not",
  );
});

/* ─────────── order-stream health governance is WIRED, not inert (D1/D4/D5/D6) ─────────── */

test("D1: the combined entry gate consults the order stream, not market data alone", () => {
  const engine = code("engine.ts");
  // The entry gate intersects both transports via the shared table wrapper.
  assert.ok(engine.includes("entryPermittedFromStreams("), "the entry gate must intersect the order stream");
  assert.ok(engine.includes("this.orderStreamState()"), "the gate must read the driven order-stream state");
  // And it still derives market-data admission from the permission table (unchanged intent).
  assert.ok(engine.includes("marketDataPermissions(state).newEntry"));
});

test("D6: the Zerodha order-stream lifecycle is DRIVEN from the quote-socket connection", () => {
  const engine = code("engine.ts");
  // onBoxLaneConnection drives the order-stream lifecycle, not just the market-data machine.
  assert.ok(engine.includes("this.driveZerodhaOrderStreamConnection("), "box-lane connection must drive the order stream");
  assert.ok(engine.includes("consumer.driveQuoteSocketLifecycle("), "the multiplexed-socket seam must be invoked");
});

test("D4: the reconnect gap-repair sweep and reconcile completion are wired", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("reconcileSweep:"), "the consumer must be given a reconnect sweep");
  const consumer = readFileSync(new URL("../../src/box/orderStreamConsumer.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(consumer.includes("runReconnectReconciliation"), "the sweep driver must exist");
  // The sweep must clear RECONCILING only on consistency — and now only for the connection epoch it
  // actually examined. The promotion is `this.machine.markSynchronized(startedAtGeneration)`: passing
  // the captured epoch is what stops a late result from promoting a NEWER connection whose gap it
  // never looked at. An unscoped promotion here would be the stale-sweep hazard back again.
  assert.ok(
    consumer.includes("this.machine.markSynchronized(startedAtGeneration)"),
    "the sweep must clear RECONCILING only on consistency AND only for the epoch it examined",
  );
  assert.ok(
    consumer.includes("startedAtGeneration !== this.machine.generation()"),
    "the sweep must discard a result whose connection epoch has been superseded",
  );
});

test("D4-DHAN: the Dhan connection actually DRIVES the reconciliation sweep (the stranding defect)", () => {
  // THE DEFECT: engine.ts's Dhan branch called onSocketOpen()/onAuthenticated() and stopped there.
  // onAuthenticated always OWES a reconciliation and markSynchronized is the only exit, so every Dhan
  // connection sat in RECONCILING and the live entry checkpoint refused every box forever.
  const engine = code("engine.ts");
  const wiring = readFileSync(new URL("../../src/box/dhanOrderStreamWiring.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  // The engine must use the extracted production wiring rather than re-implementing the lifecycle,
  // so the handlers a test drives are the handlers production uses.
  assert.ok(
    engine.includes("createDhanOrderStreamHandlers(consumer"),
    "the Dhan feed must be wired through the extracted production handler factory",
  );
  // And that factory must drive the sweep on an authorised connection.
  assert.ok(
    wiring.includes("consumer.onAuthenticated("),
    "the wiring must drive the authenticated transition",
  );
  assert.ok(
    wiring.includes("consumer.runReconnectReconciliation()"),
    "the wiring MUST start the gap-repair sweep — its absence was the stranding defect",
  );
  // Authentication evidence must stay honest: Dhan acknowledges nothing, so the wiring must say
  // `login_submitted`, never claim the broker agreed.
  assert.ok(
    wiring.includes('consumer.onAuthenticated("login_submitted")'),
    "Dhan's unacknowledged login must be recorded as submitted, not as broker-acknowledged",
  );
});

test("D4-DHAN: a targeted single-order reconcile must NOT make an account-wide readiness claim", () => {
  // The old `restReconcile` called consumer.markSynchronized() after resolving ONE order's missing
  // quantity, promoting the whole account to READY on single-order evidence — and providing an
  // accidental back door out of RECONCILING that masked the missing Dhan sweep.
  const engine = code("engine.ts");
  const restReconcileStart = engine.indexOf("restReconcile: async (");
  assert.ok(restReconcileStart > 0, "the targeted REST reconcile callback must exist");
  const restReconcileBody = engine.slice(restReconcileStart, restReconcileStart + 900);
  assert.ok(
    !restReconcileBody.includes("consumer.markSynchronized("),
    "a targeted single-order reconcile must never claim account-wide synchronization",
  );
  assert.ok(
    restReconcileBody.includes("consumer.noteRestVerifiedSession()"),
    "what it legitimately proves is that the SESSION is authorised, so that is all it may record",
  );
});

test("D4-DHAN: the production sweep returns a CHECKED verdict, not silence", () => {
  // `runReconnectReconciliation` used to promote on promise resolution alone, and the sweep was
  // `await this.orderManager?.reconcile()` — so with no order manager the expression resolved to
  // undefined and the stream went READY having examined precisely nothing.
  const engine = code("engine.ts");
  const sweepStart = engine.indexOf("reconcileSweep: async (");
  assert.ok(sweepStart > 0, "the production sweep must exist");
  const sweepBody = engine.slice(sweepStart, sweepStart + 3000);
  assert.ok(
    sweepBody.includes("synchronized: false"),
    "the sweep must be able to report the account INCONSISTENT rather than only resolving",
  );
  assert.ok(
    sweepBody.includes("report.missingAtBroker.length") && sweepBody.includes("report.positionMismatches.length"),
    "the sweep must inspect the reconcile report's discrepancies, not just that it resolved",
  );
  assert.ok(
    !sweepBody.includes("await this.orderManager?.reconcile()"),
    "an optional-chained reconcile resolves to undefined with no manager and proves nothing",
  );
});

test("D4-DHAN: an owed reconciliation is driven from a path that is actually polled", () => {
  // A connection edge is otherwise the ONLY trigger, so a single transient REST failure would strand
  // the stream until the next reconnect — on a stable socket, potentially never.
  const engine = code("engine.ts");
  assert.ok(
    engine.includes("consumer.ensureReconciled("),
    "the engine must drive an owed reconciliation from the status/gate read path",
  );
  const consumer = readFileSync(new URL("../../src/box/orderStreamConsumer.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    consumer.includes("nextSweepNotBeforeWall"),
    "the retry must be bounded by a backoff so recovery cannot flood the broker rate limit",
  );
});

test("D5: idleness is DRIVEN from a real clock against working-order expectation", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("consumer.evaluateIdle("), "the engine must drive the idle detector");
  assert.ok(engine.includes("expectedIdleMs:"), "the consumer must be given an expected-idle bound");
});

test("D2: the Zerodha text-frame OBSERVATION path is gated by the flag, not just the status label", () => {
  const engine = code("engine.ts");
  // ingestBoxLaneOrderText must drop frames unless the flag arms the observation path.
  assert.ok(engine.includes("zerodhaTextFramesConsumed()"), "the text-frame ingest must consult the observation gate");
  // The gate must appear in the ingest method, guarding BEFORE the enqueue.
  const ingest = engine.slice(engine.indexOf("ingestBoxLaneOrderText(raw: string)"));
  const gateIdx = ingest.indexOf("zerodhaTextFramesConsumed()");
  const enqueueIdx = ingest.indexOf('enqueue("order_events"');
  assert.ok(gateIdx >= 0 && gateIdx < enqueueIdx, "the flag gate must precede the enqueue, so an unarmed frame is never consumed");
  // And the honest predicate is a real export, not a comment.
  const upd = readFileSync(new URL("../../src/brokers/zerodha/orderUpdates.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(upd.includes("export function zerodhaTextFramesConsumed"), "the observation-path gate must be a real export");
});
