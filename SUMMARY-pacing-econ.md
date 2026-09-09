# SUMMARY — pacing-econ (Tasks 8 & 9)

Worktree: `/home/ubuntu/Cal/wt/pacing-econ`, branch `work/pacing-econ`, forked from
`8da7ca4`. No real orders placed, no live trading enabled, no deploy, no credentials touched,
no test contacts a real broker. Web access used ONLY to read official public documentation.

## What the code CLAIMED vs. what official docs CURRENTLY state (verified 2026-09-09)

| Claim in prior code | Official source | Current figure |
|---------------------|-----------------|----------------|
| "Dhan permits materially more than 10 order requests/second" | <https://dhanhq.co/docs/v2/> Rate Limit table | **Dhan Order APIs: 10/s, 250/min, 1,000/hr, 7,000/day; 25 modifications/order** |
| Kite: 10/s, 400/min, 5,000/day (correct, but only per-second was modelled) | <https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit> | **Kite order: 10/s, 400/min, 5,000/day; 25 modifications/order; 429 on throttle** |

The Dhan "more than 10/s" claim was the confirmed prior defect and is corrected. A Dhan support
FAQ quotes a higher 25/s figure that conflicts with the developer docs' 10/s; the stricter
developer-doc figure is used (conservative). Full table and unconfirmed figures in
`docs/BROKER_LIMITS.md`.

## Files changed and why

- **`src/box/brokerPacing.ts`** — corrected the header + Dhan profile rationale (10/s, not
  more). Added: `BrokerEndpointClass` + `isOrderEndpoint`; `BrokerRateLimits` + frozen
  `BROKER_RATE_LIMITS` (per-second/minute/hour/day, modification cap, source URL, verified date,
  `confirmed`, `unconfirmedNotes`); `OrderBudgetPolicy` (worker sharing + recovery reserve);
  `placementBudgets()`; `RateBudgetLedger` (multi-window accounting, Retry-After cooldowns,
  no-replay, external-consumer exposure); `parseRetryAfterMs`, `isRateLimited`.
- **`src/box/boxCapital.ts`** — preserved the gross-notional metric and its label unchanged.
  Added the five distinct economic quantities: `EconomicProvenance`, `EconomicFigure`,
  `brokerFigure`/`estimateFigure` (freshness + provenance), `worstCaseEntryCost`,
  `buildEconomicPicture`, `evaluateEconomicAdmission` (fail-closed, independent controls),
  `decidePartialRecovery` (one-lot-preserving recovery policy).
- **`docs/BROKER_LIMITS.md`** — per-broker per-endpoint-class table, source URLs, verification
  date, and explicit list of figures that could not be confirmed.
- **`docs/ECONOMIC_ADMISSION.md`** — the five quantities, what each can/cannot prove,
  provenance/freshness/failure semantics, before-exposure vs. partial-recovery behaviour.
- **`tests/box/brokerRateBudget.test.mjs`** (25 tests) — corrected per-second budget enforced;
  recovery survives placement saturation; total traffic never exceeds the account budget;
  Retry-After honoured and never shortened; no replay path exists; external-consumer limitation
  exposed; data reads not order-metered.
- **`tests/box/economicAdmission.test.mjs`** (16 tests) — provenance/freshness; the five stay
  distinct and are never conflated; stale/missing margin/funds fail closed; funds use broker
  margin else worst-case cost, never net debit; recovery preserves one lot.
- **`HANDOFF-pacing-econ.md`** — exact required changes in files owned by other agents.

## The pacing model

- **Per-second** spacing keeps the existing `TransportPacer` min-interval (Kite 110 ms / 100 ms
  floor; Dhan 120 ms floor, above the 100 ms the 10/s limit allows → conservative).
- **All windows** are accounted by `RateBudgetLedger` against `BROKER_RATE_LIMITS`, so an entry
  that fits the 100 ms gap but would breach the minute/day cap is refused.
- **Shared workers**: budgets are divided by `workerCount` because the broker meters the
  account, not the process.
- **Reserved recovery capacity**: a fraction (default 20%) of each window is withheld from
  entry PLACEMENT so protective cancels / exposure-reducing modifies always have room. The
  economic bound: the reserve always covers a full four-leg protective unwind (10/s ⇒ 2
  reserved; 400/min ⇒ 80). Placement is checked against the reduced ceiling; recovery against
  the per-worker ceiling (reserve included).
- **Retry-After**: `penalize()` sets a cooldown (from the header, or a conservative 1 s if
  absent) that refuses ALL order requests until it elapses and is never shortened by a later
  429.
- **No replay**: the ledger exposes no resend/replay/retry method; a 429 or transport error
  only triggers a cooldown and tells the caller not to count the request as sent.
- **Unobservable external consumers**: every `snapshot()` sets
  `external_consumers_unobservable: true` with a note requiring operational coordination —
  requests by unrelated apps on the same account are invisible to this ledger.

## The five economic quantities (each distinct, never conflated)

1. **Available broker funds** — broker-confirmed when fresh; proves deployable capital, nothing
   about the box.
2. **Planned-sequence margin** — broker basket estimate (Kite basket / Dhan multi); proves the
   broker's estimate, NOT acceptance.
3. **Peak legging exposure** — estimate; conservative upper bound (true peak needs fill order,
   owned by orderManager).
4. **Gross order notional** — existing metric, label preserved; proves max transacted ₹, NOT
   margin/peak/loss.
5. **Worst-case entry cost** — estimate; gross cost, net debit, and estimated charges as
   separate bounds.

Estimates are type-distinguished from broker-confirmed figures; stale/unavailable figures are
`usable === false` and never admit optimistically.

## Test counts

- New suites: **41 tests, 41 pass, 0 fail, 0 skipped** (`brokerRateBudget` 25 + `economicAdmission` 16).
- Full box suite: **1,502 pass** (was 1,461; +41), 0 fail, 0 skipped.
- Invariants suite: **3 pass**, 0 fail, 0 skipped.
- Full repository suite (`tests/**/*.test.mjs`, with PostgreSQL): **1,783 tests, 1,783 pass, 0
  fail, 0 skipped** (baseline 1,742 + 41 new). No existing assertion weakened, skipped, or
  marked todo.

## HANDOFF items (see HANDOFF-pacing-econ.md)

Six new config/env vars in `config.ts` + `.env.example`; wiring `RateBudgetLedger` into the
order-mutation path (check/record/penalize, classify cancels/modifies, never resend on 429);
populating and evaluating `buildEconomicPicture`/`evaluateEconomicAdmission` at pre-submit;
consulting `decidePartialRecovery` from the execution owner; a broker `availableFunds()`
accessor; surfacing the ledger snapshot + economic picture on `/api/box/status`.

## Remaining limitations

- All new surfaces are ADDITIVE and pure; they are not yet wired into the live path (that
  requires the other agents' files — HANDOFF).
- The ledger cannot observe unrelated apps on the same account (exposed, not solved).
- Peak legging exposure is a conservative upper bound, not the exact peak.
- A margin estimate never guarantees broker acceptance; only order-time acceptance is
  authoritative.
