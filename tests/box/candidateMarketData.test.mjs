/**
 * CANDIDATE-SCOPED MARKET-DATA ADMISSION — an unrelated stale instrument must not block a valid box.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `MarketDataStateMachine.reevaluate()` required EVERY desired instrument to have fresh usable depth
 * before reaching READY, and `engine` handed it `subscribedOptionTokens` — the ENTIRE streamed option
 * universe (every leg of every ATM±3 window across every streaming underlying). READY is the only
 * market-data state whose permission licenses new entry, so:
 *
 *     ONE illiquid strike in an unrelated underlying that never ticks
 *       ⇒ everyDesiredFresh() === false  ⇒  never READY
 *       ⇒ executionGateway checkpoint 1 refuses EVERY box with `feed_unhealthy`
 *
 * The refusal text even claimed "entry requires fresh usable depth per leg" — the intent was already
 * per-leg; the implementation was universe-wide.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE PINS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The real `MarketDataStateMachine` and the real `evaluateCandidateMarketData` — the exact function
 * the engine supplies to `executionGateway.candidateMarketDataAdmissible` — with the three concepts
 * kept apart:
 *   1. transport/session health (shared failure),
 *   2. subscription/scanner coverage (observability, never a gate),
 *   3. candidate entry evidence (per-leg, for these four instruments only).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MarketDataStateMachine,
  marketDataPermissions,
} from "../../dist/box/streamHealthPolicy.js";
import {
  evaluateCandidateMarketData,
  describeCandidateMarketDataVerdict,
} from "../../dist/box/candidateMarketData.js";

/* ─────────────────────────── fixtures ─────────────────────────── */

const LOT = 75;
const ROLES = ["k1_ce", "k2_ce", "k2_pe", "k1_pe"];

/** A NIFTY four-leg candidate on tokens 1001..1004. */
function candidate({ key = "NIFTY|2026-10-29|25000|25200|LONG_BOX", tokens = [1001, 1002, 1003, 1004], expiry = "2026-10-29", exchange = "NFO", lotSize = LOT, tick = 0.05 } = {}) {
  const legs = {};
  ROLES.forEach((role, i) => {
    legs[role] = {
      token: tokens[i],
      tradingsymbol: `NIFTY26OCT${25000 + i * 100}${role.endsWith("ce") ? "CE" : "PE"}`,
      exchange,
      strike: 25000 + i * 100,
      instrument_type: role.endsWith("ce") ? "CE" : "PE",
      expiry,
      lot_size: lotSize,
      tick_size: tick,
    };
  });
  return {
    key,
    underlying: "NIFTY",
    name: "NIFTY",
    is_index: true,
    expiry,
    direction: "LONG_BOX",
    lower_strike: 25000,
    upper_strike: 25200,
    box_width: 200,
    lot_size: lotSize,
    legs,
  };
}

/** A healthy, executable, uncrossed book with plenty of depth on both sides. */
function book(token, { at, exchangeAt = null, bid = 12.0, ask = 12.1, qty = 300, version = 1 } = {}) {
  return {
    token,
    bid,
    bid_qty: qty,
    ask,
    ask_qty: qty,
    last: (bid + ask) / 2,
    bids: [{ price: bid, qty, orders: 3 }],
    asks: [{ price: ask, qty, orders: 3 }],
    version,
    at,
    exchange_at: exchangeAt,
    source: "ws",
  };
}

/**
 * Build the real machine driven to READY over `desired`, with fresh depth for `freshTokens`.
 * `now` is injected so freshness is deterministic.
 */
function machineAt(now, desired, freshTokens) {
  let clock = now;
  const m = new MarketDataStateMachine({
    enabled: true,
    now: () => clock,
    heartbeatMaxAgeMs: 5_000,
    bookMaxAgeMs: 10_000,
  });
  m.onConnecting();
  m.onSocketOpen();
  m.onAuthenticated();
  m.setDesiredInstruments(desired);
  m.onFrame(clock);
  m.onHeartbeat(clock);
  for (const t of freshTokens) m.onUsableDepth(t, clock);
  m.evaluate();
  return { machine: m, setNow: (t) => { clock = t; } };
}

/** The deps object the ENGINE builds, assembled here from the same real pieces. */
function deps(machine, { now, quotes, feedGeneration = 1, tokenGenerations, quoteMaxAgeMs = 2_000, sourceMaxAgeMs, candidateLot = LOT, tradingDayStartMs = 0 }) {
  return {
    transportState: machine.state(),
    generation: machine.generation(),
    isInstrumentReady: (t) => machine.isInstrumentReady(t),
    isSubscribed: (t) => machine.isSubscribed(t),
    isTokenWarm: (t) => (tokenGenerations.get(t) ?? null) === feedGeneration,
    quote: (t) => quotes.get(t),
    now: () => now,
    quoteMaxAgeMs,
    ...(sourceMaxAgeMs === undefined ? {} : { sourceMaxAgeMs }),
    requiredQuantity: candidateLot,
    sideForRole: (role) => (role === "k1_ce" || role === "k2_pe" ? "BUY" : "SELL"),
    tradingDayStartMs,
    defaultTickSize: 0.05,
  };
}

/** A fully healthy world: four legs fresh, subscribed, warm, executable. */
function healthy({ now = 1_000_000, extraDesired = [], extraFresh = [] } = {}) {
  const cand = candidate();
  const legTokens = ROLES.map((r) => cand.legs[r].token);
  const desired = [...legTokens, ...extraDesired];
  const fresh = [...legTokens, ...extraFresh];
  const { machine, setNow } = machineAt(now, desired, fresh);
  const quotes = new Map();
  for (const t of legTokens) quotes.set(t, book(t, { at: now }));
  const tokenGenerations = new Map(desired.map((t) => [t, 1]));
  return { cand, legTokens, machine, setNow, quotes, tokenGenerations, now };
}

/* ═══════════════ 1. the headline case: an unrelated missing token must not block ═══════════════ */

test("four valid legs PLUS an unrelated missing token: the candidate is ELIGIBLE", () => {
  // Token 9999 is subscribed (it is in the streamed universe) but has NEVER ticked — exactly the
  // illiquid unrelated strike that used to hold the whole machine below READY.
  const w = healthy({ extraDesired: [9999] });

  // The TRANSPORT is READY: the pipeline is demonstrably delivering.
  assert.equal(w.machine.state(), "READY", "one never-ticking unrelated strike must not deny READY");
  assert.equal(marketDataPermissions(w.machine.state()).newEntry, true);

  // COVERAGE still reports the truth: the operator can see we are blind on one instrument.
  const cov = w.machine.coverage();
  assert.equal(cov.desired, 5);
  assert.equal(cov.fresh, 4);
  assert.equal(cov.missing, 1, "coverage is reported accurately");
  assert.deepEqual(cov.missingSample, [9999], "and names which instrument is missing");

  // And the CANDIDATE is admissible, because its own four legs are all fine.
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.deepEqual(verdict.blockers, [], "no blocker may come from an unrelated instrument");
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.sharedFailure, false);
  assert.match(describeCandidateMarketDataVerdict(verdict), /admissible/);
});

test("REPRODUCTION: the OLD universe-wide rule would have refused that very candidate", () => {
  // Demonstrate the defective predicate directly against the same evidence: a universal quantifier
  // over the desired set is false, while the existential (and the per-candidate check) are true.
  const w = healthy({ extraDesired: [9999] });
  const desired = [...w.legTokens, 9999];
  const everyDesiredFresh = desired.every((t) => w.machine.isInstrumentReady(t));
  const anyDesiredFresh = desired.some((t) => w.machine.isInstrumentReady(t));

  assert.equal(everyDesiredFresh, false, "the OLD rule: one unrelated stale token fails the universe");
  assert.equal(anyDesiredFresh, true, "the NEW rule: the pipeline is demonstrably delivering");
  assert.equal(
    w.legTokens.every((t) => w.machine.isInstrumentReady(t)),
    true,
    "and every leg of THIS candidate was fresh all along — it was refused for an unrelated reason",
  );
});

/* ═══════════════ 2. a REQUIRED leg missing or stale blocks the candidate ═══════════════ */

test("a required leg with NO book blocks the candidate", () => {
  const w = healthy();
  w.quotes.delete(w.legTokens[2]);
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_no_book" && b.role === "k2_pe"));
  assert.equal(verdict.sharedFailure, false, "this is a candidate-specific failure, not a shared one");
});

test("a required leg whose book is STALE beyond the local age bound blocks the candidate", () => {
  const w = healthy();
  // One leg's book was received 9s ago; the bound is 2s.
  w.quotes.set(w.legTokens[1], book(w.legTokens[1], { at: w.now - 9_000 }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_book_stale" && b.role === "k2_ce"));
});

test("a required leg with no fresh depth in the CURRENT generation blocks the candidate", () => {
  const w = healthy();
  // Everything is subscribed and warm, but this leg never produced usable depth this generation.
  const machine = w.machine;
  const patched = { ...deps(machine, w), isInstrumentReady: (t) => t !== w.legTokens[3] };
  const verdict = evaluateCandidateMarketData(w.cand, patched);
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_no_depth_this_generation" && b.role === "k1_pe"));
});

test("a required leg that is NOT SUBSCRIBED blocks the candidate", () => {
  const w = healthy();
  const cand = candidate({ tokens: [1001, 1002, 1003, 7777] });
  // 7777 is not in the desired set at all, and has no book.
  const verdict = evaluateCandidateMarketData(cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_not_subscribed" && b.role === "k1_pe"));
});

/* ═══════════════ 3. a candidate SWITCH cannot reuse the previous verdict ═══════════════ */

test("a candidate switch does not reuse the previous candidate's readiness", () => {
  const w = healthy();
  const good = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(good.eligible, true);

  // A DIFFERENT candidate, on instruments with no evidence at all.
  const other = candidate({ key: "BANKNIFTY|2026-10-29|54000|54200|LONG_BOX", tokens: [5001, 5002, 5003, 5004] });
  const bad = evaluateCandidateMarketData(other, deps(w.machine, w));

  assert.equal(bad.eligible, false, "the second candidate is judged on ITS OWN evidence");
  assert.equal(bad.blockers.length > 0, true);
  // And the first candidate is still fine — the verdicts are independent, because nothing is cached.
  assert.equal(evaluateCandidateMarketData(w.cand, deps(w.machine, w)).eligible, true);
});

/* ═══════════════ 4. a SHARED transport failure blocks despite fresh-looking cached books ═══════════════ */

test("a shared transport failure blocks entry even though every cached book looks fresh", () => {
  const w = healthy();
  // The socket drops. The books in the store are untouched and still look perfectly fresh.
  w.machine.onDisconnected();
  assert.equal(w.machine.state(), "DISCONNECTED");

  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.sharedFailure, true, "named as SHARED, so an operator is not sent hunting per leg");
  assert.equal(verdict.blockers.length, 1, "one clear reason, not fifteen derived leg failures");
  assert.equal(verdict.blockers[0].code, "transport_not_ready");
  assert.match(verdict.blockers[0].detail, /superseded or dead connection/);
});

test("an AUTH_EXPIRED session is a shared failure too", () => {
  const w = healthy();
  w.machine.onSessionLost();
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.sharedFailure, true);
});

/* ═══════════════ 5. a reconnect / subscription change invalidates old evidence ═══════════════ */

test("a RECONNECT advances the generation and invalidates every leg's prior depth evidence", () => {
  const w = healthy();
  assert.equal(evaluateCandidateMarketData(w.cand, deps(w.machine, w)).eligible, true);
  const genBefore = w.machine.generation();

  // Reconnect: generation advances, so depth observed under the old socket is no longer evidence.
  w.machine.onDisconnected();
  w.machine.onConnecting();
  w.machine.onSocketOpen();
  w.machine.onAuthenticated();
  w.machine.setDesiredInstruments(w.legTokens);
  w.machine.onFrame(w.now);
  assert.notEqual(w.machine.generation(), genBefore, "the generation advanced");

  // The books in the store are byte-identical and still look fresh, but they belong to the old
  // generation, so the candidate is NOT admissible.
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(
    verdict.blockers.some((b) => b.code === "leg_no_depth_this_generation"),
    "prior-generation depth is not evidence for the new connection",
  );

  // Once the legs re-tick under the NEW generation, the candidate is admissible again.
  for (const t of w.legTokens) w.machine.onUsableDepth(t, w.now);
  w.machine.evaluate();
  assert.equal(evaluateCandidateMarketData(w.cand, deps(w.machine, w)).eligible, true);
});

test("a stale ENGINE feed generation for a leg blocks the candidate", () => {
  // The engine's feedGeneration/tokenFeedGeneration is a second, independent generation check.
  const w = healthy();
  w.tokenGenerations.set(w.legTokens[0], 0); // superseded feed generation for this token
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_stale_generation" && b.role === "k1_ce"));
});

test("NARROWING the subscription set removes a leg's coverage and blocks that candidate", () => {
  const w = healthy();
  w.machine.setDesiredInstruments([w.legTokens[0], w.legTokens[1]]);
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_not_subscribed" && b.role === "k2_pe"));
});

/* ═══════════════ 6. coverage is reported without becoming a gate ═══════════════ */

test("scanner coverage stays accurate across many stale instruments without gating an intact candidate", () => {
  // 200 unrelated instruments in the universe, only the four legs ticking.
  const extra = Array.from({ length: 200 }, (_, i) => 20_000 + i);
  const w = healthy({ extraDesired: extra });

  const cov = w.machine.coverage();
  assert.equal(cov.desired, 204);
  assert.equal(cov.fresh, 4);
  assert.equal(cov.missing, 200, "coverage tells the operator we are blind on 200 instruments");
  assert.equal(cov.missingSample.length, 10, "and the diagnostic sample is BOUNDED");

  assert.equal(w.machine.state(), "READY", "but coverage is not a gate");
  assert.equal(
    evaluateCandidateMarketData(w.cand, deps(w.machine, w)).eligible,
    true,
    "and an intact candidate is still admissible",
  );
});

test("a socket that is open and heart-beating but delivering NO depth is still not READY", () => {
  // The case the old universal quantifier was defending against must still be caught: a reconnect
  // that restored the socket but not the data.
  let clock = 1_000_000;
  const m = new MarketDataStateMachine({
    enabled: true,
    now: () => clock,
    heartbeatMaxAgeMs: 5_000,
    bookMaxAgeMs: 10_000,
  });
  m.onConnecting();
  m.onSocketOpen();
  m.onAuthenticated();
  m.setDesiredInstruments([1001, 1002, 1003, 1004]);
  m.onFrame(clock);
  m.onHeartbeat(clock);
  m.evaluate();
  assert.notEqual(m.state(), "READY", "no usable depth at all ⇒ never READY");
  assert.equal(marketDataPermissions(m.state()).newEntry, false, "and no new entry");

  // A single instrument delivering depth proves the pipeline works end to end.
  m.onUsableDepth(1001, clock);
  m.evaluate();
  assert.equal(m.state(), "READY");
});

test("an empty subscription set is never READY — readiness is not claimed from silence", () => {
  let clock = 1_000_000;
  const m = new MarketDataStateMachine({ enabled: true, now: () => clock, heartbeatMaxAgeMs: 5_000, bookMaxAgeMs: 10_000 });
  m.onConnecting();
  m.onSocketOpen();
  m.onAuthenticated();
  m.setDesiredInstruments([]);
  m.onFrame(clock);
  m.evaluate();
  assert.notEqual(m.state(), "READY");
  assert.deepEqual(m.coverage(), { desired: 0, fresh: 0, missing: 0, missingSample: [] });
});

/* ═══════════════ 7. the remaining per-leg evidence requirements ═══════════════ */

test("a leg with no executable price on the side it must trade blocks the candidate", () => {
  const w = healthy();
  // k1_ce is a BUY, so it executes against the ASK. Remove the ask.
  w.quotes.set(w.legTokens[0], book(w.legTokens[0], { at: w.now, bid: 12.0, ask: 0 }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_no_executable_price" && b.role === "k1_ce"));
});

test("insufficient depth for the quantity actually being sent blocks the candidate", () => {
  const w = healthy();
  w.quotes.set(w.legTokens[0], book(w.legTokens[0], { at: w.now, qty: 10 })); // needs 75
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_no_executable_quantity" && b.role === "k1_ce"));
});

test("a CROSSED book is not a coherent snapshot", () => {
  const w = healthy();
  w.quotes.set(w.legTokens[1], book(w.legTokens[1], { at: w.now, bid: 12.5, ask: 12.0 }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_incoherent_book" && b.role === "k2_ce"));
});

test("a touch price off the instrument's TICK grid blocks the candidate", () => {
  const w = healthy();
  w.quotes.set(w.legTokens[0], book(w.legTokens[0], { at: w.now, bid: 12.0, ask: 12.03 })); // tick 0.05
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_tick_size_invalid" && b.role === "k1_ce"));
});

test("a LOT SIZE that does not divide the required quantity blocks the candidate", () => {
  const w = healthy();
  const cand = candidate({ lotSize: 40 }); // required quantity is the candidate lot size...
  // ...so force a mismatch: require 75 while the instruments carry lot_size 40.
  const verdict = evaluateCandidateMarketData(cand, { ...deps(w.machine, w), requiredQuantity: 75 });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_lot_size_invalid"));
});

test("an EXPIRED contract blocks the candidate whatever the cached book says", () => {
  const w = healthy();
  const expired = candidate({ expiry: "2020-01-30" });
  const verdict = evaluateCandidateMarketData(expired, {
    ...deps(w.machine, w),
    tradingDayStartMs: Date.UTC(2026, 8, 13),
  });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_expired"));
});

test("legs spanning MULTIPLE exchanges are an identity failure", () => {
  const w = healthy();
  const cand = candidate();
  cand.legs.k1_pe.exchange = "BFO";
  const verdict = evaluateCandidateMarketData(cand, deps(w.machine, w));
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some((b) => b.code === "leg_exchange_mismatch"));
});

/* ═══════════════ 8. source freshness is separate from locally measured age ═══════════════ */

test("a book that arrived JUST NOW but carries a 30s-old exchange timestamp is refused", () => {
  const w = healthy();
  // Fresh locally (at = now), stale at the exchange (exchange_at = now − 30s).
  w.quotes.set(w.legTokens[0], book(w.legTokens[0], { at: w.now, exchangeAt: w.now - 30_000 }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, { ...w, sourceMaxAgeMs: 2_000 }));
  assert.equal(verdict.eligible, false);
  const blocker = verdict.blockers.find((b) => b.code === "leg_source_stale");
  assert.ok(blocker, "source staleness is its own distinct condition");
  assert.match(blocker.detail, /fresh locally but stale at the exchange/);
});

test("a feed that supplies NO exchange timestamp has the source check SKIPPED, not faked", () => {
  // Dhan depth carries no exchange timestamp. Absence must not be treated as freshness, and must
  // not be treated as staleness either — the check simply does not apply.
  const w = healthy();
  for (const t of w.legTokens) w.quotes.set(t, book(t, { at: w.now, exchangeAt: null }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, { ...w, sourceMaxAgeMs: 2_000 }));
  assert.equal(verdict.eligible, true, "no source timestamp ⇒ the source bound does not apply");
  assert.ok(verdict.legs.every((l) => l.sourceAgeMs === null), "and the absence is recorded honestly");
});

/* ═══════════════ 9. the audit trail ═══════════════ */

test("the verdict carries per-leg evidence for the audit trail, and reports every blocker", () => {
  const w = healthy();
  w.quotes.delete(w.legTokens[0]);
  w.quotes.set(w.legTokens[1], book(w.legTokens[1], { at: w.now - 9_000 }));
  const verdict = evaluateCandidateMarketData(w.cand, deps(w.machine, w));

  assert.equal(verdict.legs.length, 4, "every leg is accounted for");
  assert.equal(verdict.generation, w.machine.generation(), "the generation is stamped for audit");
  assert.ok(verdict.blockers.length >= 2, "ALL blockers are reported, not just the first");
  const codes = verdict.blockers.map((b) => b.code);
  assert.ok(codes.includes("leg_no_book"));
  assert.ok(codes.includes("leg_book_stale"));
  assert.match(describeCandidateMarketDataVerdict(verdict), /insufficient/);
});
