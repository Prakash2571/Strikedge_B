# Evidence — items 2 & 3: order-update stream wiring into live execution

Branch `feat/order-stream-integration`. Baseline before this track: 1903 pass / 0 fail / 0 skip.
After: **1923 pass / 0 fail / 0 skip**. Build, `no-live-hostnames.sh`, `no-egress-guard.mjs` all pass.

## The defect this track closed

Before: `OrderUpdateProjection`, `DhanOrderFeed`, `parseKiteOrderFrame` and `streamHealthPolicy`
had ZERO production callers (reproduced by grep). `ZERODHA_ORDER_STREAM_ENABLED` /
`DHAN_ORDER_STREAM_ENABLED` only changed a status label; `engine.orderStreamConsumers` was never
populated, so `orderStreamStatus()` always reported `wiring:"not_wired"`,
`fills_observed_by:"rest_polling_only"`.

## Production wiring table

| Module | Constructor site | Production caller | Event source | Durable consumer | Proving test |
| --- | --- | --- | --- | --- | --- |
| `OrderStreamConsumer` | `src/box/orderStreamConsumer.ts` | `src/box/engine.ts:692` (per active broker at engine start) | stream + REST | `OrderUpdateProjection` (one per broker account) | `tests/box/orderStreamConsumer.test.mjs`, `tests/box/orderStreamRealWaiter.test.mjs` |
| `parseKiteOrderFrame` | `src/brokers/zerodha/orderUpdates.ts` | `src/box/engine.ts:5144` via `onTextFrame` → `registry.ts:474` → `zerodha/feed.ts:111` | Kite quote-socket TEXT frame | consumer projection | `orderStreamRealWaiter` |
| `DhanOrderFeed` | `src/brokers/dhan/orderFeed.ts` | `src/brokers/registry.ts:524` `createDhanOrderFeed`, invoked `engine.ts:5185` when `DHAN_ORDER_STREAM_ENABLED` | Dhan order socket `order_alert` | consumer projection | `orderStreamConsumer.test.mjs` |
| `OrderStreamConsumer.registerIntent` | — | `src/box/orderManager.ts:1886` BEFORE `submitOrder` (checkpoint 4) | durable intent | projection ledger | `orderStreamRealWaiter` (ownership before POST) |
| `streamHealthPolicy` (`OrderStreamStateMachine`) | `src/box/streamHealthPolicy.ts` | inside `OrderStreamConsumer` (`machine`), lifecycle hooks from feed | transport lifecycle | consumer health | `orderStreamConsumer.test.mjs` |
| `engine.orderStreamConsumers` | `src/box/engine.ts:463` | populated at `engine.ts:715` and `refreshOrderStreamConsumerHealth` (5125) | consumer health | status route | `contract` suite |

## Wake-vs-refresh race (found while wiring, fixed here)

Failing-first: `tests/box/orderStreamRealWaiter.test.mjs` drives the REAL `KiteBrokerAdapter`
through `submitOrder → waitForResolution` with a fake transport whose `getOrder` never reports a
fill, delivers a fill through the production consumer, and asserts the waiter resolves on the
event with `getOrder` call count 0.

- BEFORE the fix the test hung (rc=124 at 40s), because after `waitOrObservation` woke on the
  stream fill the loop unconditionally re-polled REST and `normalizeKiteOrder` overwrote the
  fresh terminal snapshot with the stale OPEN one — the event was discarded and the loop looped.
- AFTER the fix (adopt the session snapshot after wake; return without re-poll when already
  terminal; `pendingObservation` edge-latch): both cases pass —

```
✔ a stream fill resolves the REAL KiteBrokerAdapter waiter before the REST poll interval (4.5ms)
✔ without a stream event, the SAME adapter waiter falls back to the REST poll (controlled fallback) (0.9ms)
```

Same fix applied to `DhanBrokerAdapter`.

## Rules enforced (mapped to the brief)

- Ownership before POST — `orderManager.ts:1886` (register) precedes `:1923` (submit).
- One projection of truth — REST snapshots feed `noteStreamBrokerSnapshot` → same
  `OrderUpdateProjection` as the stream; dedup + cumulative monotonicity hold across both.
- Missing ≠ zero — absent quantity schedules targeted REST reconciliation, applies no quantity,
  never terminalises on a label (`orderStreamConsumer.ts` ingest path).
- Socket-open is not READY — `OrderStreamStateMachine` only reaches READY after reconciliation.
- Account-wide events attributed by ownerTag + account, unowned/foreign rejected (projection).

## Not finished in this track (handed to later tracks)

- Market-data generation invalidation / per-instrument readiness (item 4).
- Rate/economic/funnel wiring (item 8) — **now completed**, see `EVIDENCE-rate-econ-funnel.md`.
- Frontend surfacing of the new stream health (item 10).
