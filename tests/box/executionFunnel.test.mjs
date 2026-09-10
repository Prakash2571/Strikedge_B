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


test("REQUIRED: the displayed success rate cannot be improved by hiding rejects, partials, recovery or unresolved exposure", () => {
  // An HONEST run: 100 candidates, 20 qualified, 20 admitted; of those, 12 were refused before
  // any POST, 8 actually reached a broker; of the 8, 3 opened cleanly, 2 filled-then-aborted at a
  // loss, 2 were partial-entry recoveries, 1 left unresolved exposure.
  const honest = new ExecutionFunnel();
  honest.recordCandidateEvaluated(100);
  for (let i = 0; i < 20; i++) { honest.recordQualified(); honest.recordAdmitted(); }
  for (let i = 0; i < 12; i++) honest.recordEntryOutcome({ outcome: "REFUSED_BEFORE_SUBMIT", submitted: false, zeroPostReason: "capital" });
  for (let i = 0; i < 3; i++) { honest.recordSubmitted(); honest.recordEntryOutcome({ outcome: "OPENED", submitted: true }); }
  for (let i = 0; i < 2; i++) { honest.recordSubmitted(); honest.recordEntryOutcome({ outcome: "FILLED_THEN_ECONOMICS_ABORT", submitted: true, realisedNetPnl: -300, recoveryCost: 120 }); }
  for (let i = 0; i < 2; i++) { honest.recordSubmitted(); honest.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_UNWOUND", submitted: true, recoveryCost: 75 }); }
  honest.recordSubmitted(); honest.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_RESIDUAL", submitted: true, leftUnresolvedExposure: true });
  const h = honest.snapshot();

  // The honest broker-facing completion rate: 3 opened / 8 submitted.
  assert.equal(h.ratios.execution_completion_rate.numerator, 3);
  assert.equal(h.ratios.execution_completion_rate.denominator, 8);

  // GAMING ATTEMPT 1 — hide the rejected attempts (never record the 12 refusals). The completion
  // rate's denominator is attempts that touched a broker, which the refusals are NOT part of, so
  // omitting them changes execution_completion_rate by exactly nothing. (They only affect the
  // submission_rate, which EXISTS precisely to keep them visible.)
  const hideRejects = new ExecutionFunnel();
  hideRejects.recordCandidateEvaluated(100);
  for (let i = 0; i < 20; i++) { hideRejects.recordQualified(); hideRejects.recordAdmitted(); }
  for (let i = 0; i < 3; i++) { hideRejects.recordSubmitted(); hideRejects.recordEntryOutcome({ outcome: "OPENED", submitted: true }); }
  for (let i = 0; i < 2; i++) { hideRejects.recordSubmitted(); hideRejects.recordEntryOutcome({ outcome: "FILLED_THEN_ECONOMICS_ABORT", submitted: true, realisedNetPnl: -300, recoveryCost: 120 }); }
  for (let i = 0; i < 2; i++) { hideRejects.recordSubmitted(); hideRejects.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_UNWOUND", submitted: true, recoveryCost: 75 }); }
  hideRejects.recordSubmitted(); hideRejects.recordEntryOutcome({ outcome: "PARTIAL_ENTRY_RESIDUAL", submitted: true, leftUnresolvedExposure: true });
  const r = hideRejects.snapshot();
  assert.equal(
    r.ratios.execution_completion_rate.rate,
    h.ratios.execution_completion_rate.rate,
    "hiding pre-submit refusals cannot improve the broker-facing completion rate",
  );

  // GAMING ATTEMPT 2 — count a partial fill or an economics-abort as a success. The ONLY way to
  // raise execution_completion_rate is to increase four_leg_completed_entries, and a partial /
  // abort is not four legs. Try to reclassify the 2 aborts + 2 partials as OPENED and observe that
  // this is simply a DIFFERENT run (a lie), not a re-presentation: the honest snapshot's completed
  // count is fixed at 3 and its rate at 3/8. There is no snapshot method that raises the numerator
  // without an actual four-leg completion.
  assert.equal(h.four_leg_completed_entries, 3, "only genuine four-leg completions count");
  assert.equal(h.submitted_failures, 5, "the 2 aborts + 2 partials + 1 residual are submitted failures, visible");

  // GAMING ATTEMPT 3 — hide recovery costs / unresolved exposure to flatter the economics. The
  // realised P&L and recovery costs are summed from the recorded outcomes; there is no path that
  // adds an OPEN or a profit without also carrying its cost. Recovery cost and unresolved exposure
  // are their own published counts, so dropping them would be a smaller, MORE-suspicious snapshot,
  // never a better rate.
  assert.equal(h.recovery_costs_included, 120 * 2 + 75 * 2, "every recovery cost is inside the published total");
  assert.equal(h.unresolved_exposure_total, 1, "unresolved exposure is cumulative and cannot be un-counted");
  assert.ok(h.realised_net_pnl < 0, "the loss stands; a losing run cannot render as profitable");

  // GAMING ATTEMPT 4 — quote the FLATTERING denominator (3/20 admitted, or 3/100 candidates) as if
  // it were the completion rate. The snapshot forbids this by BINDING each numerator to one stated
  // denominator with a verbatim basis string, so a reader always sees which population it is.
  assert.match(h.ratios.execution_completion_rate.basis, /attempts with >=1 real broker POST/);
  assert.match(h.ratios.admission_rate.basis, /qualified opportunities/);
  assert.match(h.ratios.submission_rate.basis, /admitted attempts/);
  assert.notEqual(
    h.ratios.execution_completion_rate.denominator,
    h.ratios.admission_rate.denominator,
    "the completion denominator is distinct from the admission denominator; they cannot be swapped",
  );
});
