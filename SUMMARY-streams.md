# SUMMARY — broker order-update streams (work/streams)

## What was verified about the current REST-polling-only behaviour (file:line)

- `src/ticker.ts:100` (pre-change) — `// Text frames are postbacks (order updates / error
  messages) — ignore.` followed by `if (typeof data === "string") return;`. Kite streams order
  updates as TEXT frames on THIS quote socket, so the fast fill path was received and discarded.
- `src/box/orderLifecycle.ts` — already models the fast path: `FillEventSource` includes
  `"order_update"` ("A broker order-update stream event — the fast path") and `"postback"`
  ("Lowest trust; never the sole basis for a state change"); `CumulativeFillLedger` already
  enforces dedup-by-event-id, cumulative monotonicity, and loud (never clamped) overfill. This
  work builds ON that ledger rather than inventing a parallel one.
- `src/box/dhanBrokerAdapter.ts` — `refresh()` calls `fetchFills()` → `getTradesForOrder()`
  (line ~714) BEFORE projecting the order. The order snapshot already carries `filledQty`
  (authoritative cumulative), so this per-trade enrichment is nonessential for exposure — the
  exact "do not block prompt publication on trade-detail" hazard the brief names.
- `src/box/kiteBrokerAdapter.ts` — REST `getOrder`/`listOrders` shape `BrokerOrder`; monotonic
  cumulative and stable-tag reconciliation (`stableKiteTag`, `reconcileByTag`) already exist.
  Fills were observed only when these REST reads ran (poll/verify), never pushed.

## Official documentation (verified 2026-09-09)

- ZERODHA (Kite Connect v3):
  - WebSocket streaming, "Postbacks and non-binary updates":
    https://kite.trade/docs/connect/v3/websocket/ — order updates arrive on the SAME quote
    socket (`wss://ws.kite.trade`) as TEXT frames `{ "type": "order", "data": {…} }` (also
    `"error"` / `"message"`). "Always check the type … Market data is always binary and
    Postbacks and other updates are always text."
  - Postback payload: https://kite.trade/docs/connect/v3/postbacks/ — fields used:
    `order_id`, `status` (COMPLETE/REJECTED/CANCELLED/UPDATE), `filled_quantity` (cumulative),
    `average_price`, `tag` (≤20 chars — our ownership key), `user_id` (account),
    `exchange_update_timestamp`.
- DHAN (DhanHQ v2):
  - Live Order Update: https://dhanhq.co/docs/v2/order-update/ — a DEDICATED socket
    `wss://api-order-update.dhan.co`, SEPARATE from the market feed `wss://api-feed.dhan.co`
    (https://dhanhq.co/docs/v2/live-market-feed/). Auth message
    `{ "LoginReq": { "MsgCode": 42, "ClientId", "Token" }, "UserType": "SELF" }`. Each update is
    JSON `{ "Type": "order_alert", "Data": {…} }` with `TradedQty` (cumulative executed qty),
    `AvgTradedPrice`, `Status` (TRANSIT/PENDING/REJECTED/CANCELLED/TRADED/EXPIRED),
    `CorrelationId` (≤30 chars — our ownership key), `OrderNo` (Dhan order id), `ClientId`
    (account). The cumulative fill quantity is IN the alert — no trade-detail fetch is needed.

## Unified projection design (`src/box/orderUpdateProjection.ts`)

ONE truth: stream events AND REST snapshots are both normalized to
`NormalizedOrderObservation` and funnelled into a per-order `CumulativeFillLedger`. Rules:

- OWNERSHIP FIRST. `register()` records `ownerTag` (Kite tag / Dhan correlationId) → clientId,
  the account, and (once known) brokerOrderId → clientId. `ingest()` resolves an observation to
  a registered order by tag then broker id. No match ⇒ `unowned` and DROPPED (another app's
  order). Tag match but a DIFFERENT `account` ⇒ `foreign_account` and dropped. This is the
  structural guard against attributing a foreign fill to a box leg.
- DEDUP + MONOTONICITY come free from the shared ledger: a duplicate event id ⇒
  `duplicate_event`; a cumulative at/below the current ⇒ `stale_cumulative` (this is what makes
  a redelivered stream event, a REST poll echoing a stream value, and an out-of-order arrival
  all harmless). Quantity NEVER regresses; a regression is refused and (if a sequence is
  present) flagged. Overfill is applied (broker truth) and surfaced, never silently clamped.
- DURABLE-INTENT-FIRST. `register()` is meant to be called as `CREATED → SUBMITTING` is
  persisted, BEFORE the POST — so a fill that beats the placement HTTP response has a ledger to
  land in. `register()` is idempotent (re-registration keeps the same ledger), so restart
  adoption never resets exposure.
- PROMPT PUBLICATION (Dhan). `DhanOrderFeed` builds the observation from `TradedQty` directly
  and hands it to `onObservation` synchronously; there is NO trade-detail seam to await.

## Reconnect reconciliation

`onStreamDisconnected()` fabricates nothing — it touches no ledger, invents no terminal state,
disables no exposure management. It records a gap and sets `reconcilePending()`. On reconnect,
`onStreamConnected({ reconnect: true })` moves health to `RECONNECTED_PENDING_RECONCILE` and
keeps `reconcilePending()` true; the caller runs a REST sweep (source `reconciliation` /
`rest_poll`) whose observations flow through the same ledger and recover any fills missed in the
gap — the gap is REPAIRED from REST, never assumed empty. Only after the sweep does
`markReconciled()` return the stream to `LIVE`. REST is never removed; it is the fallback and
the reconciliation source throughout.

## Market-data vs order-stream health — structural separation

Order-stream health is its OWN type (`OrderStreamHealth`, states
DISABLED/DOWN/CONNECTING/LIVE/RECONNECTED_PENDING_RECONCILE) produced by
`OrderUpdateProjection.orderStreamHealth()`, with no field derived from the market-data
`FeedHealth` (`brokers/feedHealth.ts`). A test pins that a market feed reporting `LIVE` while
the order stream is `DOWN` at the same instant reads as order-stream-down — the two cannot be
confused because they are different types with different lifecycles. For DHAN the separation is
also physical: two different sockets (`api-feed` vs `api-order-update`).

## The Dhan prompt-publication rule

`parseDhanOrderAlert` + `DhanOrderFeed.onObservation` publish the cumulative `TradedQty`
immediately. The transport has no `getTradesForOrder` call and awaits nothing before
publishing. Test: "a Dhan order_alert publishes cumulative fill evidence from TradedQty alone
(no trade-detail fetch)".

## Safety posture

OFF by default: `zerodhaOrderStreamEnabledFromEnv()` / `dhanOrderStreamEnabledFromEnv()` return
false unless the env var is exactly `true` (module-local parsing per `dhanHttpConfigFromEnv`
precedent; `config.ts`/`.env.example` untouched). A stream ONLY observes — it can never place an
order. `ticker.ts` forwarding is inert unless a consumer supplies `onTextFrame`. All tests use
injected fake sockets; no test opens a real socket or contacts a broker. No real order placed,
no live trading enabled, no deploy, no credential change.

## Exact test counts

- New suite `tests/box/orderUpdateStreams.test.mjs`: 14 tests, 14 pass, 0 fail, 0 skipped.
- `tests/box/*.test.mjs`: 1549 pass (was 1536), 0 fail, 0 skipped.
- `tests/invariants/*.test.mjs`: 3 pass, 0 fail.
- Full `npm test` (DATABASE_URL set): 1831 tests, 1831 pass, 0 fail, 0 skipped, 0 todo.
  Baseline 1817 + 14 new. No existing assertion weakened/skipped/todo.

## HANDOFF items (see HANDOFF-streams.md)

1. Feed the projection into durable order state in `orderManager.ts` (register on
   CREATED→SUBMITTING; learn broker id on ACK; route REST snapshots through `ingest`; gate the
   reconnect sweep on `reconcilePending()`).
2. Construct/start the transports in `index.ts`/registry behind the env gates; wire lifecycle
   callbacks to the projection; dispose on switch/shutdown.
3. Surface `orderStreamHealth()` alongside `computeFeedHealth` in the status payload.
4. Optionally document the two env flags in `.env.example` (owned elsewhere).

## Remaining limitations only real broker observation could settle

- Exact wire quirks: whether Kite ever omits `tag` on a partial-fill postback, and whether Dhan
  ever emits `order_alert` with a stale/lower `TradedQty` under modification — both are already
  SAFE here (empty tag ⇒ recorded `unowned` not misattributed; lower cumulative ⇒
  `stale_cumulative`), but the real frequency is unknown without live capture.
- Whether Dhan sends any auth-ack frame (docs show none), so we optimistically mark authorised
  on send and rely on an auth close-code to detect rejection; a live session would confirm the
  close codes actually used.
- Real end-to-end latency reduction vs REST polling — the fast path is structurally present and
  tested, but the actual millisecond improvement can only be measured against a live account.
