# SUMMARY — hedge quantity barrier

Branch `work/hedge`, forked from main `8da7ca47846a64d93499c521772b0747b293e5ee`.
Worktree `/home/ubuntu/Cal/wt/hedge`. No file owned by another agent was modified.

## The defect (re-verified against current code)

Dependent uncovered SELL permission was gated on the ABSENCE OF A NAMED HEDGE
FAILURE, not on PROVEN COVERAGE. The two are not complements.

- `src/box/liveEntryGuard.ts` (pre-fix): `LiveEntryGuardInputs.hedgeFailure:
  string | null`, documented as "A definitive failure of a BUY hedge this leg
  depends on". The guard refused a dependent SELL only when `hedgeFailure !==
  null`. There was no confirmed-quantity input anywhere in the guard.
- `src/box/orderManager.ts` (pre-fix, `execute()`): after `submitOrder` returned
  a `BrokerOrder`, `hedgeFailureReason` was set ONLY for
  `RECONCILE_STATES` (UNKNOWN/RECONCILIATION_REQUIRED) and `state === "REJECTED"`
  (plus the ambiguous/throw branches). A hedge that returned **CANCELLED with
  `filled_quantity: 0`**, or OPEN, or PARTIALLY_FILLED-then-terminal below the
  required lot, left `hedgeFailureReason === null`. `decideEntryTransportRank`
  then recorded no `gate.hedgeFailure`, the hedge-first barrier released the
  parked SELL, and the pre-POST guard saw `hedgeFailure === null` → the naked
  full-size SELL was transmitted.

I verified this EMPIRICALLY before changing anything: a probe wiring the REAL
gateway → manager → recording adapter, with both BUY hedges returning
`CANCELLED`/0-filled, transmitted BOTH SELL legs (`k1_ce`, `k2_pe`) to the
broker with `result.ok === false` — i.e. the gateway's post-hoc `fullyFilled`
check noticed there was no box, but ONLY AFTER the naked SELLs had already been
POSTed. That is the safety defect: the naked short exposure is created before
the whole-set check runs. Confirmed at entry concurrency 1 and 4, both
directions (see EVIDENCE-hedge.md: 10 failing-first cases on the old code).

## The new guard / coverage contract

Permission is inverted from "no known failure" to "proven sufficient coverage":

- A dependent SELL may POST only when EVERY BUY hedge of the attempt is PROVEN to
  have filled its FULL required quantity, attributed on every axis: attempt id,
  role, contract (token AND tradingsymbol), side (a hedge is a BUY),
  broker/account, and requested quantity.
- Coverage is created ONLY from the broker's OWN TERMINAL snapshot
  (`isBrokerOrderTerminal`) and its cumulative `filled_quantity`. Broker
  acceptance, an order id, an ACK, an OPEN/working state, an UNKNOWN/ambiguous
  state, or a state the classifier merely failed to name are NOT coverage.
- The contract/side/quantity are taken from the BROKER SNAPSHOT, not the request,
  so a fill the broker reports on the wrong contract or side covers nothing.
- Attribution is single-use and attempt-scoped (`claimCoverage`), so one hedge
  fill cannot back an incompatible dependent under a future multi-lot profile.
- FAIL CLOSED: absent, non-terminal, mismatched or insufficient evidence yields
  no coverage. The default is zero.
- Enforced at the post-barrier `pre_post` checkpoint only — the one point at
  which the hedge-first barrier guarantees every hedge has decided — so a SELL is
  never refused before it has waited for its hedges, yet can never POST without
  proof. The earlier checkpoints keep enforcing ownership/arm/breaker/admission
  exactly as before.
- ENTRY only. EXIT / PROTECTIVE_CANCEL / EMERGENCY_RESIDUAL never build coverage
  and are never blocked by it (verified: existing invariants + ownership-guard
  exit tests stay green).

## Files changed and why

- **`src/box/hedgeCoverageLedger.ts` (NEW).** The attributed, single-use,
  attempt-scoped proof-of-fill ledger. `HedgeRequirement` is what a hedge must
  prove; `HedgeOutcomeEvidence` is the broker's terminal observation;
  `coverageFor`/`coverageGapFor`/`claimCoverage` (lines 158/199/218) return
  positive proof or a specific gap. Pure in-memory state, no I/O.
- **`src/box/liveEntryGuard.ts`.** Replaced input `hedgeFailure` with
  `hedgeCoverageGap: string | null` (line 111; `null` = proven covered) and the
  refusal code `hedge_leg_failed` with `hedge_coverage_unproven` (line 71,
  evaluated at 146-150). Documented the inversion.
- **`src/box/orderManager.ts`.** `EntryTransportGate` now carries a
  `HedgeCoverageLedger` (line 1368) and per-rank `hedgeRequirements`. A BUY hedge
  declares its requirement at registration (`ensureEntryTransportGate`).
  `decideEntryTransportRank` records the broker's terminal snapshot as evidence
  (`gate.coverage.record`, line 1448) via `hedgeEvidenceFrom` (line 1468), which
  reads contract/side/qty from the snapshot when terminal and records `null`
  fill otherwise. `execute()` captures the terminal `BrokerOrder` (line 1826) for
  the `finally` release. `entryHedgeCoverageGap` (line 1299) computes the SELL's
  coverage verdict, enforced only at `pre_post` (line 1277). `hedgeFailure` is
  retained as a diagnostic only. Added `brokerAccountKey()` for the account axis.
- **`src/box/executionGateway.ts`.** The two gateway-side checkpoints
  (pre_build/pre_enqueue) pass `hedgeCoverageGap: null` — coverage is not
  applicable before any hedge exists and is asserted at the manager's pre_post.
- **`tests/box/hedgeQuantityBarrier.test.mjs` (NEW).** The failing-first
  regression suite (19 tests).
- **`tests/box/liveEntryOwnershipGuard.test.mjs`.** Updated the pure-guard unit
  test's two references to the new inverted contract (`hedgeCoverageGap` /
  `hedge_coverage_unproven`). No assertion weakened.

## Test evidence (verbatim in EVIDENCE-hedge.md)

- BEFORE (original main src, build clean): `tests/box/hedgeQuantityBarrier.test.mjs`
  → **19 tests, 9 pass, 10 fail, 0 skipped, 0 todo.** The 10 failures are the
  naked-SELL cases (both-cancelled @ c=1 and c=4, single-hedge-cancelled,
  partial-below-required, raced-partial-that-stays-short, wrong-contract), both
  directions.
- AFTER (fixed src, build clean): same file → **19 tests, 19 pass, 0 fail,
  0 skipped, 0 todo.**

## Exact test counts (suites I ran, fixed src)

- `tests/box/*.test.mjs`: **1480 tests, 1480 pass, 0 fail, 0 skipped, 0 todo.**
- `tests/invariants/*.test.mjs`: **3 tests, 3 pass, 0 fail, 0 skipped, 0 todo.**
- Full `npm test` (with `DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge`):
  **1761 tests, 1761 pass, 0 fail, 0 skipped, 0 todo.** Baseline on unmodified
  main was 1742/1742/0/0; +19 new, no regressions.

## HANDOFF items

See HANDOFF-hedge.md. One OPTIONAL, non-blocking note: a first-class per-account
identifier on `BrokerAdapter` (owned by another agent) would strengthen the
`broker_account` attribution axis for a future multi-account-per-manager
deployment. Not required for this fix; the current key derivation
(`broker:${adapter.mode}`) is correct for one account per manager, which is the
present deployment. No cross-owned file was changed and the
`BeforeBrokerPost = () => void` throwing-refusal contract is untouched.

## Remaining limitation only real broker observation could settle

The fix draws coverage from the broker's TERMINAL snapshot and its cumulative
`filled_quantity`. Two things only a live broker can confirm:

1. That the live Kite/Dhan adapters actually deliver a genuinely TERMINAL snapshot
   with a settled cumulative quantity (never a pre-terminal read presented as
   terminal) at the moment the hedge decides. The code fails closed if they do
   not — a non-terminal or absent snapshot yields no coverage and blocks the SELL
   — but the exact terminalisation timing under real exchange latency and the
   cancel-vs-fill race is a property of the live adapters (owned elsewhere) and
   the exchange, not of this layer. The tests mock every broker response.
2. The economically optimal behaviour when a hedge is PARTIALLY filled but not
   cancellable in time: this fix correctly REFUSES the full-size dependent SELL
   (fail closed, one-lot-per-leg), leaving the partial hedge as attributed
   exposure the existing partial-entry recovery handles. Whether a smaller,
   partial-sized SELL would ever be preferable is a live-observation and
   product question, deliberately out of scope: never guess a size while an
   order can still fill.
