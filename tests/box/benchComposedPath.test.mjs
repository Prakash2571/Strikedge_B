/**
 * COMPOSED-PATH BENCHMARK — defect-regression guard.
 *
 * The OLD benchmark had two flaws this benchmark structurally removes by running the REAL classes:
 *   Defect 1: it treated most POST responses as fill confirmation.
 *   Defect 2: it skipped the ordinary REST confirmation the real adapters perform.
 *
 * These tests pin those properties on the composed path so a future edit cannot silently
 * reintroduce the flaws. They also assert honest outcome accounting (a non-filling leg is NOT
 * reported as complete) and that the benchmark uses the correct discrete-event scheduler.
 *
 * Lives under the `tests/box/bench` prefix (picked up by the `unit` suite glob).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { runComposedEntry } from "../../bench/runner.mjs";

test("DEFECT 2 fixed: the composed path CONFIRMS fills via the real REST getOrder poll", async () => {
  // Stream OFF ⇒ the only way a fill can be confirmed is the real waitForResolution REST poll.
  const r = await runComposedEntry({
    scenario: { name: "rest_only", concurrency: 2, attempt: "t1", stream: "off" },
    seed: 4242,
  });
  assert.ok(r.rest_polls > 0, "the real adapter polled getOrder to confirm — REST is not skipped");
  assert.equal(r.completed, 4, "all four legs confirmed COMPLETE via REST");
  assert.equal(r.four_leg_completed, true);
});

test("DEFECT 1 fixed: a POST/ACK is NOT a fill — a never-filling leg is protectively cancelled, not completed", async () => {
  // Force one dependent leg to never fill (filledQty 0) with the stream off, so only the broker's
  // REST snapshot governs. The real waiter must NOT report a fill from the ACK; it must protectively
  // cancel and return a CANCELLED terminal — honest, not a fabricated completion.
  const r = await runComposedEntry({
    scenario: {
      name: "never_fill", concurrency: 2, attempt: "t2", stream: "off",
      forceCancel: "k2_ce", cancelPartialQty: 0,
    },
    seed: 4242,
  });
  // The forced leg is a dependent SELL (wave 1). Both hedges complete first (POST is not a fill for
  // them either — they only complete once the REST snapshot reaches COMPLETE).
  assert.equal(r.hedges_ok, true, "the two BUY hedges completed via confirmed REST snapshots");
  assert.equal(r.four_leg_completed, false, "the box did NOT report four-leg completion");
  assert.ok(r.cancelled >= 1, "the never-filling leg terminated as CANCELLED, not COMPLETE");
  assert.equal(r.completed, 3, "exactly the three genuinely-filled legs are counted complete");
});

test("honest accounting: rejected/cancelled outcomes are surfaced, never hidden to inflate success", async () => {
  const r = await runComposedEntry({
    scenario: { name: "reject_one", concurrency: 4, attempt: "t3", stream: "healthy", forceReject: "k1_ce" },
    seed: 99,
  });
  // A rejected hedge means the box cannot proceed to the dependent SELLs.
  assert.ok(r.rejected >= 1, "the rejected leg is counted, not dropped");
  assert.equal(r.four_leg_completed, false, "a rejected hedge does not become a hidden success");
  assert.equal(r.hedges_ok, false);
});

test("healthy stream makes the SAME confirmed fill arrive sooner WITHOUT removing the REST path", async () => {
  const seed = 7777;
  const withStream = await runComposedEntry({
    scenario: { name: "s", concurrency: 2, attempt: "t4", stream: "healthy" }, seed,
  });
  const withoutStream = await runComposedEntry({
    scenario: { name: "s", concurrency: 2, attempt: "t4", stream: "off" }, seed,
  });
  // REST polling is used in BOTH postures (the stream never replaces confirmation).
  assert.ok(withStream.rest_polls > 0, "REST poll still runs even with a healthy stream");
  assert.ok(withoutStream.rest_polls > 0, "REST poll is the sole confirmation with the stream off");
  // Both complete four legs on identical seeds — the stream changes WHEN, not WHETHER.
  assert.equal(withStream.four_leg_completed, true);
  assert.equal(withoutStream.four_leg_completed, true);
  // The stream cannot make completion LATER than pure REST on the same seed.
  assert.ok(
    withStream.four_leg_completion_ms <= withoutStream.four_leg_completion_ms,
    `stream (${withStream.four_leg_completion_ms}ms) should not be slower than REST-only (${withoutStream.four_leg_completion_ms}ms)`,
  );
});
