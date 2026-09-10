# Evidence — items 4, 5 & 6: market-data recovery, timestamps, backpressure

Branch `feat/order-stream-integration`. Commits: `a391358` (MarketDataStateMachine), `001407c`
(drive it from the live feed lifecycle), `bd712b3` (bounded-queue backpressure primitive),
`e3cff40` (config default + contract version for the added status fields).

Independently verified after the track (`npx tsc -b --force`): **suites 1961 pass / 0 fail /
0 skip** (unit 1679, invariants 3, tokens 48, access 31, switch 32, shutdown 11, readiness 24,
contract 44, pg 72, projector 17). Build, `no-live-hostnames.sh`, `no-egress-guard.mjs` pass.

## Item 4 — market-data recovery (GAP 1: the state machine was defined but nothing drove it)

`MarketDataState` existed with a permission table but no machine transitioned it, so it did not
gate entry. Now `MarketDataStateMachine` (streamHealthPolicy.ts) is constructed at
`engine.ts:657` and DRIVEN from the real feed lifecycle:

| Signal | Driver (file:line) |
| --- | --- |
| connecting / socket-open / authenticated (advance generation, drop readiness) | `engine.driveMarketDataConnection` |
| desired instruments vs confirmed readiness | `engine.ts:1941` `setDesiredInstruments` |
| last received frame | `engine.ts:2182` `onFrame` (hot path) |
| first usable depth PER instrument, current generation | `engine.ts:2186` `onUsableDepth(token)` |
| processing backlog / event-loop stall | `engine.ts:1944` / `:678` `onProcessingBacklog` |
| session lost / auth expiry | `engine.onMarketDataSessionLost` ← `registry` onDead/onSessionLost |
| entry gate | `executionGateway` dep `marketDataEntryPermitted` refuses entry as `feed_unhealthy` when not READY |

Enforced rules: READY is unreachable by mere socket-open (requires fresh usable depth per traded
instrument in the current generation); reconnect advances generation and invalidates
previous-generation executable books (`engine.invalidateBooks`); DESIRED subscriptions are kept
separate from CONFIRMED/OBSERVED readiness; the four time facts (transport heartbeat, last
received frame, last valid depth, per-instrument book age) are distinct; protective cancel / exit
/ attributed reduction remain permitted in DEGRADED/DISCONNECTED per the permission table; feeds
use bounded backoff and distinguish auth-close from transient error (no fast-forever reconnect on
a known-invalid token).

Proving tests: `tests/box/marketDataStateMachine.test.mjs` (11 pure-machine), 
`tests/box/marketDataStateMachineWiring.test.mjs` (5 production call-site).

## Item 5 — honest timestamps and ordering (verified present + enforced; no rewrite needed)

| Requirement | Where enforced |
| --- | --- |
| monotonic vs wall clock distinct | `executionClock.ts` `mono()` / `wall()` |
| four distinct time facts | `engine.ts` `lastRawTickAt` (raw frame), `quotes.lastUpdateAt` (last valid depth), `tokenFeedGeneration` (per-instrument gen), `sampleExchangeLag` (exchange time) |
| Zerodha exchange ts at documented precision (whole seconds) | `quotes` `exchange_at`; coherence `maxExchangeAheadOfReceiveMs` 1500 tolerant of 1s granularity |
| Dhan LastTradeTime NOT used as book publication time | `dhan/feed.ts` `toTick` omits an exchange book timestamp |
| no invented exchange sequence numbers | documented in `BROKER_STREAM_DOCS.md` + `executionCoherence.ts`; dedup rests on cumulative monotonicity |
| no simultaneous-snapshot assumption across a multi-instrument frame | per-token generation + per-leg freshness |
| configurable + enforced freshness/dispersion/lag | `executionCoherence.evaluateBookCoherence` (called by both live and paper); config `quoteMaxAgeMs`, `feedMaxAgeMs`, `maxCrossLegReceiveDispersionMs` (500), `maxCrossLegExchangeDispersionMs` (250, coarse), `maxReceiveToExchangeDelayMs` |

Defaults are consistent with whole-second exchange stamps; no sub-second exchange threshold that
would reject valid coarse data.

## Item 6 — backpressure (GAP 2: no bounded-queue primitive existed in production)

`StagePipeline` (`boundedQueue.ts`) is constructed at `engine.ts:667` with an `order_events`
stage. The WS callback `ingestBoxLaneOrderText` stays lightweight — it ENQUEUES the raw frame and
returns (`engine.ts:5453`); a coalesced, bounded microtask pump (`scheduleIngestPump`) drains it
into the order-stream consumer off the socket callback. The order-event stage is `never-drop`:
capacity is a pressure THRESHOLD (default 512), not a cap. On overload it records the degraded
condition, raises the market-data backlog signal (which BLOCKS new entry), and triggers
`orderManager.reconcile()` — while still holding and delivering every event (a missing order
event is never a zero fill). Exposure management (exit/cancel) does not route through this queue,
so it is never blocked. The queue exposes depth, oldest-queued-event age and an overload signal.

Proving test: `tests/box/boundedQueue.test.mjs` (8) — includes a slow consumer that cannot block
or drop order-event processing, and overload raising the backlog signal without dropping events.

## Grep proof of production wiring

```
engine.ts:657   this.marketDataMachine = new MarketDataStateMachine({...})
engine.ts:2182  this.marketDataMachine.onFrame()
engine.ts:2186  this.marketDataMachine.onUsableDepth(token)
engine.ts:667   this.ingestPipeline = new StagePipeline({...})
engine.ts:5453  this.ingestPipeline.enqueue("order_events", raw, "order_events")
executionGateway.ts  dep marketDataEntryPermitted -> refuses entry as feed_unhealthy
```

## Not finished in this track

- Item 9 (benchmark), item 10 (frontend surfacing of `market_data_state` / `market_data_health` /
  queue lag), item 11 (Mumbai config), item 12 (remaining failure-scenario integration tests).
- The MarketDataStateMachine is driven from the box lane's tick path; a dedicated per-instrument
  reconnect-warmup timer beyond the book-age gate is left as a tuning follow-up (the age gate
  already prevents a stale instrument from being executable).
