# HANDOFF — pacing-econ

Changes required in files I do NOT own, to wire the additive surfaces I built. I made none of
these; they are recorded here for the owning agents. My modules' public surface is additive so
this wiring is purely additive too.

## src/box/config.ts  (owned by another agent)

Add config so the new budget ledger and economic controls are operator-tunable. Suggested env
vars and `BoxConfig` fields:

| Env var | BoxConfig field | Default | Purpose |
|---------|-----------------|---------|---------|
| `BOX_LIVE_ORDER_WORKER_COUNT` | `orderWorkerCount: number` | `1` | Workers sharing ONE broker account's order budget. Feeds `resolveOrderBudgetPolicy({ workerCount })`. |
| `BOX_LIVE_RECOVERY_RESERVE_FRACTION` | `recoveryReserveFraction: number` | `0.2` | Fraction of each order window withheld from placement for protective cancels. Clamp [0, 0.5]. |
| `BOX_LIVE_MARGIN_FRESHNESS_MS` | `marginFreshnessMaxAgeMs: number` | `2000` | Max age a broker margin figure may be to count as usable (`brokerFigure`). |
| `BOX_LIVE_FUNDS_FRESHNESS_MS` | `fundsFreshnessMaxAgeMs: number` | `5000` | Max age a broker funds figure may be to count as usable. |
| `BOX_LIVE_REQUIRE_MARGIN_EVIDENCE` | `requireMarginEvidence: boolean` | `false` | When true, refuse entry unless a fresh broker margin figure exists. |
| `BOX_LIVE_REQUIRE_FUNDS_COVER` | `requireFundsCover: boolean` | `false` | When true, refuse entry unless funds cover the requirement. |

Defaults preserve current behaviour (single worker; economic controls disabled → same as today).

## .env.example  (owned by another agent)

Document the six vars above with the same defaults and one-line explanations.

## src/box/orderManager.ts / executionCoordinator.ts / executionGateway.ts  (other agents)

1. **Consume `RateBudgetLedger`** for order placement/modify/cancel:
   - call `ledger.check(klass, now)` before each order mutation; if refused, do NOT send.
   - call `ledger.record(klass, now)` only after the request is durably attempted.
   - on a `429` (`isRateLimited(status)`), call `ledger.penalize(now, parseRetryAfterMs(header, now))`
     and do **not** resend the mutation — rely on the existing idempotency layer.
   - classify cancels as `order_cancel` and exposure-reducing modifies as `order_modify` so they
     may use the recovery reserve.
2. **Populate the economic picture** at pre-submit: call `buildEconomicPicture(...)` with broker
   funds (from `brokerContext` funds facility) and planned margin (from the existing basket-margin
   call), then `evaluateEconomicAdmission(...)`. Refuse on `allowed === false`.
3. **Partial recovery**: when a box is partially exposed, consult `decidePartialRecovery(...)`
   instead of re-checking the original entry edge.

## src/box/brokerContext.ts note

`BoxMarginProvider.basketMargin` already exists and returns `BoxBasketMargin` with a `source` and
`hedge_benefit`. To feed quantity #1 (available funds) an equivalent `availableFunds()` accessor is
needed on the broker context. This file IS in my ownership list, but adding a funds accessor that
calls broker adapters would reach into adapter code I do not own; I left the interface additive and
recommend the owning agent add the concrete funds fetch. (I did not add a funds method to avoid a
partial interface with no implementation.)

## Observability

Surface `RateBudgetLedger.snapshot(now)` and the `EconomicPicture` on the existing
`/api/box/status` diagnostics endpoint (index.ts / status assembler, other agents), including the
`external_consumers_unobservable` flag and note.
