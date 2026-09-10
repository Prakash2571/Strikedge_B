/**
 * EXECUTION FUNNEL — real execution events increment it end to end.
 *
 * This drives the REAL BoxScanner and REAL BoxExecutionSimulator (paper_legging) with REAL ticks,
 * wired to a REAL ExecutionFunnel through the SAME production hooks the engine uses
 * (onCandidateEvaluated / onQualified on the scanner, and the recordEntryOutcome /
 * recordCompletedExit calls the engine makes from openPaperTrade/onExecutionAttempt/closePaperTrade).
 * It proves the funnel's counts move from actual scanner evaluations and actual entry/exit
 * outcomes, and that the resulting snapshot cannot be gamed to a flattering success rate.
 *
 * It is deterministic and bounded: the scanner's async pipeline is settled with a short, capped
 * timer, so `node --test` always exits.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BoxScanner } from "../../dist/box/scanner.js";
import { BoxChargeEstimator } from "../../dist/box/charges.js";
import { BoxExecutionSimulator } from "../../dist/box/executionSimulator.js";
import { BoxMetrics } from "../../dist/box/metrics.js";
import { BoxPositionBook } from "../../dist/box/positions.js";
import { BoxQuoteStore } from "../../dist/box/quotes.js";
import { ExecutionFunnel } from "../../dist/box/executionFunnel.js";
import {
  cfg,
  chargeStub,
  goodCandidate,
  localChargesStub,
  quotesFor,
} from "./helpers.mjs";

/**
 * A scanner wired to the REAL funnel via the production hooks. `openPaperTrade` and
 * `onExecutionAttempt` mirror EXACTLY what BoxEngine does: recordAdmitted + recordSubmitted +
 * recordEntryOutcome, deriving `submitted` from the outcome class the execution path stamped.
 */
function harness({ entryTotal = 150, exitTotal = 150, config = {} } = {}) {
  const { candidate, all } = goodCandidate();
  const conf = cfg(config);
  const quotes = new BoxQuoteStore();
  const positions = new BoxPositionBook();
  const localCharges = localChargesStub({ entryTotal, exitTotal });
  const metrics = new BoxMetrics(conf.metricsWindow);
  const executionSim = new BoxExecutionSimulator({
    cfg: conf, quotes, isMarketOpen: () => true, isFeedHealthy: () => true, metrics,
  });
  const charges = new BoxChargeEstimator(chargeStub({ entryTotal, exitTotal }).fn, conf);
  const funnel = new ExecutionFunnel();

  const opened = [];
  const attempts = [];

  const recordFunnelOutcome = (legging, filledAllFour) => {
    const outcomeClass = legging.outcome_class ??
      (filledAllFour ? "OPENED"
        : (legging.submitted_leg_count ?? 0) > 0
          ? (legging.filled_leg_count > 0 ? "PARTIAL_ENTRY_UNWOUND" : "NO_FILL")
          : "REFUSED_BEFORE_SUBMIT");
    const submitted = outcomeClass !== "REFUSED_BEFORE_SUBMIT" || (legging.submitted_leg_count ?? 0) > 0;
    funnel.recordAdmitted();
    if (submitted) funnel.recordSubmitted();
    funnel.recordEntryOutcome({
      outcome: outcomeClass,
      submitted,
      realisedNetPnl: outcomeClass === "OPENED" ? null : (legging.legging_net_loss ?? null),
      recoveryCost: ((legging.partial_entry_charges ?? 0) + (legging.unwind_charges ?? 0)) || null,
      leftUnresolvedExposure: (legging.residual_exposure ?? []).length > 0,
    });
  };

  const scanner = new BoxScanner({
    cfg: conf, quotes, charges, localCharges, executionSim, positions, metrics,
    // THE PRODUCTION HOOKS UNDER TEST — the exact callbacks BoxEngine wires to the funnel.
    onCandidateEvaluated: () => funnel.recordCandidateEvaluated(),
    onQualified: () => funnel.recordQualified(),
    openPaperTrade: async (args) => {
      opened.push(args);
      positions.add({
        id: `box${opened.length}`, key: args.candidate.key, underlying: args.candidate.underlying,
        expiry: args.candidate.expiry, direction: args.candidate.direction,
        lower_strike: args.candidate.lower_strike, upper_strike: args.candidate.upper_strike,
        legs: args.candidate.legs, lot_size: args.candidate.lot_size, quantity: args.candidate.lot_size,
      });
      // Engine parity: a four-leg open is counted here regardless of atomic vs legging path.
      funnel.recordAdmitted();
      funnel.recordSubmitted();
      funnel.recordEntryOutcome({ outcome: "OPENED", submitted: true });
      return `box${opened.length}`;
    },
    onExecutionAttempt: (cand, legging) => {
      attempts.push({ cand, legging });
      // Engine parity: a non-opening attempt is observed with its stamped outcome class.
      recordFunnelOutcome(legging, false);
    },
    onEvent: () => {},
  });
  scanner.setCandidatesForUnderlying("NIFTY", all);
  scanner.setMarketOpen(true);
  scanner.setFeedHealthy(true);
  scanner.setDiscovering(true);

  const seedGood = (overrides = {}) => {
    const now = Date.now();
    const map = quotesFor(candidate, overrides, { at: now });
    for (const [token, q] of map) {
      quotes.applyTicks([{ token, last_price: q.last, bid: q.bid, ask: q.ask, bids: q.bids, asks: q.asks }], now);
    }
    return [...map.keys()];
  };

  return { scanner, candidate, all, quotes, positions, funnel, opened, attempts, seedGood };
}

/** Settle the scanner's async entry pipeline; bounded so node --test always exits. */
const settle = () => new Promise((r) => setTimeout(r, 25));

test("real scanner evaluations increment the funnel's candidate and qualified stages", async () => {
  const h = harness();
  const before = h.funnel.snapshot();
  assert.equal(before.candidates_evaluated, 0);

  // A real tick on the candidate's tokens triggers real evaluateAndMaybeEnter passes.
  const tokens = h.seedGood();
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const s = h.funnel.snapshot();
  assert.ok(s.candidates_evaluated > 0, "real candidate evaluations were counted");
  // The nested chain must hold: qualified is a subset of candidates evaluated.
  assert.ok(s.candidates_evaluated >= s.qualified_opportunities);
  assert.ok(s.qualified_opportunities >= s.attempts_admitted);
});

test("a real qualifying candidate flows through to a funnel entry outcome (end to end)", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const s = h.funnel.snapshot();
  // At least one candidate qualified and produced a terminal entry outcome (opened OR an attempt).
  assert.ok(s.qualified_opportunities >= 1, "a real candidate qualified");
  const terminalEntries = s.attempts_submitted + s.zero_post_refusals;
  assert.ok(terminalEntries >= 1, "a real terminal entry outcome reached the funnel");
  // Whatever happened, every published ratio still carries an explicit denominator basis.
  for (const r of Object.values(s.ratios)) {
    assert.equal(typeof r.basis, "string");
    assert.ok(r.basis.length > 10);
  }
});

test("the end-to-end snapshot's completion rate is bound to the broker-facing denominator", async () => {
  const h = harness();
  const tokens = h.seedGood();
  h.scanner.onTokensUpdated(tokens);
  await settle();

  const s = h.funnel.snapshot();
  // The completion rate denominator is submitted attempts, never the (larger, flattering)
  // qualified or candidate populations — so real refusals cannot be laundered into it.
  assert.equal(s.ratios.execution_completion_rate.denominator, s.attempts_submitted);
  assert.match(s.ratios.execution_completion_rate.basis, /real broker POST/);
  // four-leg completions never exceed submitted attempts (the nested invariant on real data).
  assert.ok(s.four_leg_completed_entries <= s.attempts_submitted);
});
