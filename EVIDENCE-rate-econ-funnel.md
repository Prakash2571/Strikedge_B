# Evidence — item 8: rate, economic and outcome modules connected to production

Branch `feat/order-stream-integration`. Commits: rate `55b3cbe`, econ `a95d7c2`, funnel
`a18444b`, status contract `32534b1`, rate-limit re-verification `e172e63`.

Independently verified after the track (forced rebuild `npx tsc -b --force`):
**suites 1937 pass / 0 fail / 0 skip** (unit 1655, invariants 3, tokens 48, access 31, switch 32,
shutdown 11, readiness 24, contract 44, pg 72, projector 17). Build, `no-live-hostnames.sh`,
`no-egress-guard.mjs` all pass.

## The gap this track closed

Before, these had ZERO production callers (reproduced by grep): `RateBudgetLedger`
(brokerPacing.ts), `evaluateEconomicAdmission` / `buildEconomicPicture` (boxCapital.ts),
`ExecutionFunnel` (executionFunnel.ts). They were built and unit-tested but nothing constructed
and called them, so the review correctly found item 8 unintegrated.

## Production wiring table

| Module | Constructor site | Production caller | Event source | Durable consumer | Proving test |
| --- | --- | --- | --- | --- | --- |
| `RateBudgetLedger` | `registry.ts:1538` (one per broker, lazy, reused across adapter rebuilds) | `kiteBrokerAdapter.ts:444` `refusePlacementIfBudgetExhausted` + `:1036` `reserveRecoveryBudgetOrThrow`; injected via `registry.ts:1508/1522` and `zerodha/liveAdapter.ts:57` | adapter `call()` per endpoint class | shared ledger `registry.ts:1535` | `tests/box/rateBudgetProductionWiring.test.mjs` (4) |
| `evaluateEconomicAdmission` + `buildEconomicPicture` | boxCapital.ts (pure) | `executionGateway.ts:361` `evaluateEntryEconomics` inside `simulateLeggingEntry` (entry only; reduction/exit exempt) | fresh funds via `adapter.margins()`, planned margin via `margins.basketMargin` | `gateway.economicDiagnostics()` in status | `tests/box/economicAdmissionWiring.test.mjs` (6) |
| `ExecutionFunnel` | `engine.ts:392` | candidate/qualified `engine.ts:966-967` (scanner hooks); admitted/submitted/OPENED `:2875-2877`; entry outcome `:4253-4255`; completed exit + unresolved `:3092-3093` | real scanner + gateway + observeAttempt + exit | `getStatus().execution_funnel` `engine.ts:5105` | `tests/box/funnelProductionWiring.test.mjs` (3) + `executionFunnel.test.mjs` (10) |

## Required integration proofs (the three the brief demands)

**Rate exhaustion prevents a prohibited transmission.** `rateBudgetProductionWiring.test.mjs`
drives the REAL adapter with a counting mock transport; after the placement budget is spent the
next entry placement is rejected and the transport `placeCalls()` stays at 1 — the over-budget
POST never reached the wire — while a protective cancel still transmits (recovery reserve). Proven
for both Kite (`assert.equal(transport.placeCalls(), 1, "the over-budget placement never reached
the transport")`) and Dhan (`assert.equal(client.calls.place, 1, "NO additional Dhan order POST
reached the transport")`).

**Missing/stale funds or margin evidence blocks entry.** `economicAdmissionWiring.test.mjs`:
missing funds → `entry.ok === false`, `outcome_class === "REFUSED_BEFORE_SUBMIT"`,
`submitted.length === 0`; stale funds → refused, nothing submitted; missing margin evidence →
refused, nothing submitted; fresh covering funds → admitted, all four legs submitted. The four
economic quantities are distinct in `economicDiagnostics().picture`: `gross_notional`,
`planned_margin`, `peak_legging_exposure`, `worst_case_entry`.

**Real execution events increment the funnel, and the rate cannot be gamed.**
`funnelProductionWiring.test.mjs` drives a real `BoxScanner` + `BoxExecutionSimulator` through the
production hooks; candidate/qualified increment from real ticks and the completion rate is bound
to the broker denominator. `executionFunnel.test.mjs` asserts every ratio carries a
numerator/denominator/basis and that hiding rejects/partials/recovery/unresolved or swapping a
flattering denominator is impossible (`zero_post_refusals` stays fully visible and attributed).

Failing-first was captured by the implementer by disconnecting the scanner hooks (candidates
stayed 0, tests failed) then restoring them (green); and by neutralising each gate (POST count
rose / submitted became 4 / funnel stayed empty) before wiring.

## Rate limits verified

See `docs/BROKER_LIMITS.md`, re-verified 2026-09-10 against Kite Connect and DhanHQ v2 published
docs (commit `e172e63`; no change from the prior figures). Windows and endpoint classes
(order_place / order_modify / order_cancel / data_read) are enforced; one application-owned budget
per account is shared across adapters; recovery capacity is reserved so a rate storm cannot starve
protective cancellation; Retry-After / 429 penalise the ledger; order mutations are never blindly
retried. External account activity outside this process is documented as unobservable.

## Test-harness notes (for reproducibility)

- `tsc -b` incremental did not reliably pick up changes for these files; use `npx tsc -b --force`
  before running `node --test` (tests import from `dist/`).
- The wiring tests resolve orders via `adapter.applyOrderUpdate` (the stream path) rather than REST
  polling, and use a tiny per-DAY budget, so they are deterministic under a frozen test clock and
  `node --test` exits cleanly (no hang).

## Not finished in this track

- Item 9 (benchmark of the composed production path), item 10 (frontend), item 11 (Mumbai
  config), item 12 (remaining failure-scenario integration tests) are separate tracks.
