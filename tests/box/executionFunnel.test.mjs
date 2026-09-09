/**
 * THE EXECUTION FUNNEL — denominators, and the separation of execution from economics.
 *
 * The whole point of the funnel is that no ratio can be quoted without the population it
 * was computed from, and that a flattering denominator cannot be substituted for an honest
 * one. These tests assert exactly that, plus the two properties most easily got wrong:
 * zero-POST refusals must not dilute the broker-facing completion rate, and an
 * execution success that lost money must appear as both.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ExecutionFunnel } from "../../dist/box/executionFunnel.js";

test("every ratio carries its numerator, denominator and a stated basis", () => {
  const f = new ExecutionFunnel();
  const s = f.snapshot();
  for (const [name, r] of Object.entries(s.ratios)) {
    assert.equal(typeof r.numerator, "number", `${name} numerator`);
    assert.equal(typeof r.denominator, "number", `${name} denominator`);
    assert.equal(typeof r.basis, "string", `${name} basis`);
    assert.ok(r.basis.length > 10, `${name} basis must actually describe the population`);
  }
});

test("an undefined ratio is null, never 0 — absence must not render as failure", () => {
  const f = new ExecutionFunnel();
  const s = f.snapshot();
  assert.equal(s.ratios.execution_completion_rate.denominator, 0);
  assert.equal(
    s.ratios.execution_completion_rate.rate,
    null,
    "0 attempts must not report a 0% success rate",
  );
});

test("zero-POST refusals are counted but do NOT dilute the broker-facing completion rate", () => {
  const f = new ExecutionFunnel();
  // 10 qualified, all admitted. 8 refused locally before any POST, 2 actually submitted,
  // and both of those completed all four legs.
  for (let i = 0; i < 10; i++) { f.recordQualified(); f.recordAdmitted(); }
  for (let i = 0; i < 8; i++) {
    f.recordEntryOutcome({ outcome: "REFUSED_BEFORE_SUBMIT", submitted: false, zeroPostReason: "coherence" });
  }
  for (let i = 0; i < 2; i++) {
    f.recordSubmitted();
    f.recordEntryOutcome({ outcome: "OPENED", submitted: true, realisedNetPnl: 1000 });
  }
  const s = f.snapshot();

  assert.equal(s.zero_post_refusals, 8, "free refusals are fully visible");
  assert.equal(s.zero_post_by_reason.coherence, 8, "and attributed to a cause");
  assert.equal(s.attempts_submitted, 2);
  assert.equal(s.four_leg_completed_entries, 2);

  // The honest completion rate is 2/2 against attempts that touched a broker — NOT 2/10,
  // which would blame the broker path for cheap local refusals.
  assert.equal(s.ratios.execution_completion_rate.numerator, 2);
  assert.equal(s.ratios.execution_completion_rate.denominator, 2);
  assert.equal(s.ratios.execution_completion_rate.rate, 1);
  assert.match(s.ratios.execution_completion_rate.basis, /excludes zero-POST/);

  // But the submission rate makes the 8 refusals impossible to hide.
  assert.equal(s.ratios.submission_rate.numerator, 2);
  assert.equal(s.ratios.submission_rate.denominator, 10);
});

test("an execution SUCCESS that lost money is reported as both, never as one", () => {
  const f = new ExecutionFunnel();
  f.recordQualified(); f.recordAdmitted(); f.recordSubmitted();
  // All four legs filled, then the economics failed and it was unwound at a real cost.
  f.recordEntryOutcome({
    outcome: "FILLED_THEN_ECONOMICS_ABORT",
    submitted: true,
    realisedNetPnl: -450,
    recoveryCost: 180,
  });
  const s = f.snapshot();

  // Execution: it is a submitted attempt that did NOT open a box, so it counts as a
  // submitted failure with its own distinct cause.
  assert.equal(s.submitted_failures, 1);
  assert.equal(s.submitted_failures_by_reason.economics_abort_after_fill, 1);
  assert.equal(s.four_leg_completed_entries, 0, "no box was opened");

  // Economics: the loss and the recovery cost are both counted, not excluded as exceptional.
  assert.equal(s.realised_net_pnl, -450);
  assert.equal(s.recovery_costs_included, 180, "recovery cost is never hidden");
  assert.equal(s.economically_unprofitable, 1);
});

test("partial-entry recoveries and unresolved exposure are tracked with a live gauge", () => {
  const f = new ExecutionFunnel();
  for (let i = 0; i < 3; i++) { f.recordQualified(); f.recordAdmitted(); f.recordSubmitted(); }
  f.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_UNWOUND", submitted: true, recoveryCost: 90 });
  f.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_RESIDUAL", submitted: true, leftUnresolvedExposure: true });
  f.recordEntryOutcome({ outcome: "NO_FILL", submitted: true });

  let s = f.snapshot();
  assert.equal(s.partial_entry_recoveries, 2);
  assert.equal(s.no_fill_cancellations, 1);
  assert.equal(s.unresolved_exposure_open, 1, "one still outstanding right now");
  assert.equal(s.unresolved_exposure_total, 1, "and cumulatively one ever occurred");

  // Resolving it moves the gauge down but leaves the cumulative history intact.
  f.recordUnresolvedExposureResolved();
  s = f.snapshot();
  assert.equal(s.unresolved_exposure_open, 0);
  assert.equal(s.unresolved_exposure_total, 1, "history is not rewritten by resolution");
});

test("the exposure gauge never goes negative", () => {
  const f = new ExecutionFunnel();
  f.recordUnresolvedExposureResolved();
  f.recordUnresolvedExposureResolved();
  assert.equal(f.snapshot().unresolved_exposure_open, 0);
});

test("a contradictory outcome (pre-submit refusal marked submitted) trusts the outcome label", () => {
  const f = new ExecutionFunnel();
  f.recordQualified(); f.recordAdmitted();
  // The execution path stamps REFUSED_BEFORE_SUBMIT itself, so that label wins over a
  // caller's `submitted: true` rather than inventing a broker submission.
  f.recordEntryOutcome({ outcome: "REFUSED_BEFORE_SUBMIT", submitted: true, zeroPostReason: "capital" });
  const s = f.snapshot();
  assert.equal(s.zero_post_refusals, 1);
  assert.equal(s.zero_post_by_reason.capital, 1);
  assert.equal(s.submitted_failures, 0, "a proven no-POST is not a submitted failure");
});

test("the economic success rate cannot exceed 1 even when clean exits add profit", () => {
  const f = new ExecutionFunnel();
  f.recordQualified(); f.recordAdmitted(); f.recordSubmitted();
  f.recordEntryOutcome({ outcome: "OPENED", submitted: true, realisedNetPnl: 500 });
  // Several profitable exits accumulate, which must not push the rate above 1 against the
  // completed-entry denominator.
  f.recordCompletedExit(300);
  f.recordCompletedExit(200);
  const s = f.snapshot();
  assert.equal(s.completed_exits, 2);
  assert.ok(s.ratios.economic_success_rate.rate <= 1, "ratio stays sane");
  assert.equal(s.realised_net_pnl, 1000, "raw totals stay unclamped and auditable");
});

test("the nested chain is monotonically non-increasing (each stage is a subset)", () => {
  const f = new ExecutionFunnel();
  f.recordCandidateEvaluated(50);
  for (let i = 0; i < 6; i++) f.recordQualified();
  for (let i = 0; i < 4; i++) f.recordAdmitted();
  for (let i = 0; i < 3; i++) { f.recordSubmitted(); f.recordEntryOutcome({ outcome: "OPENED", submitted: true }); }
  const s = f.snapshot();
  assert.ok(s.candidates_evaluated >= s.qualified_opportunities);
  assert.ok(s.qualified_opportunities >= s.attempts_admitted);
  assert.ok(s.attempts_admitted >= s.attempts_submitted);
  assert.ok(s.attempts_submitted >= s.four_leg_completed_entries);
});
