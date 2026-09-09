# HANDOFF — broker order-update streams

Items that require changes to files this worktree does NOT own, or coordination with the
composition layer. Recorded here per the ownership rules rather than edited directly.

## 1. Feed the projection into durable order state (owner: `src/box/orderManager.ts`)

`OrderUpdateProjection` (new, owned) is the single funnel for stream + REST observations and
holds the authoritative `CumulativeFillLedger` per order. It does NOT write durable state.
The integration the OrderManager owner must add:

- On persisting `CREATED → SUBMITTING` (BEFORE the POST), call `projection.register({
  clientOrderId, ownerTag, account, requestedQty, brokerOrderId: null })`. The `ownerTag` is
  `stableKiteTag(clientOrderId)` for Zerodha and `dhanCorrelationId(clientOrderId)` for Dhan —
  both already computed on the order path. This is what lets a pre-arrival fill land.
- On acknowledgement (broker order id known), call
  `projection.learnBrokerOrderId(clientOrderId, brokerOrderId)`.
- Where the adapter currently applies a REST `BrokerOrder` snapshot, ALSO route it through
  `projection.ingest({ ownerTag, brokerOrderId, account, cumulativeQty: filled_quantity,
  averagePrice, source: "rest_poll", eventId })` so stream and REST share one ledger and
  dedup against each other. The ledger's `cumulative` then becomes the single source of the
  order's filled quantity (it already enforces the monotonicity the adapter open-codes at
  `dhanBrokerAdapter.ts` refresh / `kiteBrokerAdapter.ts` and `orderLifecycle.ts`).
- Gate the reconnect REST sweep on `projection.reconcilePending()`; call
  `projection.markReconciled()` after the sweep completes.

## 2. Construct + start the transports in the composition layer (owner: `src/index.ts` / registry)

`src/index.ts` and `src/brokers/registry.ts` assemble the hub/feeds/adapters. To activate the
fast path (still OFF by default):

- ZERODHA: pass an `onTextFrame` into the `connectTicker(...)` options used by the Box lane's
  `ZerodhaFeed` / `TickerHub`, guarded by `zerodhaOrderStreamEnabledFromEnv()`; forward the
  frame to `parseKiteOrderFrame` and, for `type === "order"`, stamp times and
  `projection.ingest(...)`. `TickerHub`/`ZerodhaFeed` are owned here, but the wiring to the
  live projection instance is a composition-layer decision (which broker is active, which
  account).
- DHAN: when `dhanOrderStreamEnabledFromEnv()` and a live session exists, construct
  `new DhanOrderFeed({ accessToken, clientId, onObservation, onConnecting, onConnected,
  onDisconnected, onSessionLost })` and call `.start()`. Wire `onConnecting/onConnected/
  onDisconnected` to `projection.onStreamConnecting()/onStreamConnected()/onStreamDisconnected()`.
  Tear it down on broker switch / shutdown via `.dispose()` alongside the existing feed teardown.

The env flags are intentionally NOT added to `.env.example` (owned by the coherence agent) —
document `ZERODHA_ORDER_STREAM_ENABLED` and `DHAN_ORDER_STREAM_ENABLED` there when convenient.

## 3. Surface order-stream health in the status/diagnostics payload (owner: `src/box/routes.ts` / engine diagnostics)

`projection.orderStreamHealth()` returns an `OrderStreamHealth` that is structurally distinct
from `computeFeedHealth`'s `FeedHealth`. The status endpoint should report BOTH, side by side,
so a live market feed with a dead order stream reads as `feed: LIVE, order_stream: DOWN`.

## 4. Config keys (owner: `src/box/config.ts` / `.env.example` — NOT edited here)

Per the brief, configuration follows the module-local env precedent, so no `config.ts` change
is required for the gate. If a central toggle is later wanted, add
`ZERODHA_ORDER_STREAM_ENABLED` / `DHAN_ORDER_STREAM_ENABLED` (booleans, default false).
