# Evidence — item 12: integration-test coverage of the live execution path

Branch `feat/order-stream-integration`. This is the INTEGRATION-TEST track. Its job is to test
the integration of the already-wired components (items 1A-1D, 2, 3, 4, 5, 6, 8), not to re-test the
helpers in isolation. It fills the gaps in the required failure-scenario matrix and pins the five
named integration proofs to PRODUCTION objects.

Baseline before this track (tracked code, verified): **1961 pass / 0 fail / 0 skip** across
`unit invariants tokens access switch shutdown readiness contract pg projector`.

> Note on the working tree: an untracked sibling file `tests/box/composedBenchmarkSmoke.test.mjs`
> (item 9, the composed-path benchmark) is present and currently fails because its `bench/**`
> harness is still in progress. Those files are sibling-owned (`bench/**`, and the benchmark smoke
> test that drives them) and are NOT part of this track's baseline. All counts here are for the
> tracked suite excluding that uncommitted sibling artifact.

## Scenario inventory (read by assertion, not by filename)

Every "already covered" entry below was confirmed by reading the file's assertions, not the name or
an evidence doc. `file:line` points at the load-bearing assertion or the test declaration.

| # | Required failure scenario | Already covered by (file:line) | Added by this track (file:line) |
|---|---|---|---|
| 1 | Both short-closing BUYs fail during exit | `tests/box/defectAExitHedgeDependencies.test.mjs` (both-hedges-fail cases); `tests/box/hedgeQuantityBarrier.test.mjs:58` (both BUY hedges cancelled → no uncovered SELL) | — |
| 2 | Partial short close then attempted hedge release | `tests/box/hedgeQuantityBarrier.test.mjs` ("a hedge PARTIALLY filled below its lot → NO full-size SELL"); `tests/box/defectAExitHedgeDependencies.test.mjs` (releasable = hedge_outstanding − short_still_outstanding) | — |
| 3 | Dhan terminal update missing quantity or price | `tests/box/defect2DhanTerminalAccounting.test.mjs:94` (TRADED w/ no cumulative ≠ COMPLETE-0); `tests/box/defectBDhanEvidenceValidation.test.mjs:107,152` (terminal label w/ no qty; CANCELLED w/ missing qty) | — |
| 4 | Coherence deteriorates during queue/pacing | `tests/box/defectCSendBoundaryCoherence.test.mjs:71` (C1 dispersion during pacing BLOCKS every POST) — **this is also named proof #5** | — |
| 5 | Entry disarmed before actual network send | `tests/box/defect3SendBoundaryGuard.test.mjs` (guard fires at HTTP send boundary); `tests/box/liveEntryOwnershipGuard.test.mjs:168` (disarm during pacing → 0 POST) | — |
| 6 | Queue deadline expires | `tests/box/defectDPromptDeadlineSettlement.test.mjs` (D1/D2/D3: released on own budget, never transmits, proven no-POST) | — |
| 7 | Stream event arrives before POST acknowledgement | `tests/box/orderUpdateStreams.test.mjs:70` (stream fill before placement HTTP response applied) | — |
| 8 | Stream and REST report the same fill | `tests/box/orderUpdateStreams.test.mjs` (#1 REST no-op after stream; #3 STREAM-vs-REST dedup) | — |
| 9 | Delayed LOWER cumulative quantity | `tests/box/orderUpdateStreams.test.mjs:137` (regression refused); `tests/box/orderStreamConsumer.test.mjs:214`; `tests/box/defectBDhanEvidenceValidation.test.mjs:315` | — |
| 10 | Cancel races with a fill | `tests/box/cancelFillRace.test.mjs` (REQUIRED 3&4: terminal cumulative wins); `tests/box/orderStreamConsumer.test.mjs:371` (fill after cancel not lost) | — |
| 11 | WebSocket disconnects during EACH entry/exit stage | Consumer-level disconnect only: `tests/box/orderStreamConsumer.test.mjs` (DISCONNECTED perms), `tests/box/marketDataStateMachineWiring.test.mjs`. **GAP: no disconnect DURING a live entry/exit stage through the real gateway/manager.** | `tests/box/disconnectDuringStage.test.mjs` |
| 12 | Old socket emits after reconnect | `tests/box/orderStreamConsumer.test.mjs:389` (superseded socket frame dropped) | — |
| 13 | Socket stays open but stops supplying usable data | `tests/box/orderStreamConsumer.test.mjs` (onIdle → DEGRADED, no new entry); `tests/box/marketDataStateMachine.test.mjs:84` | — |
| 14 | Subscription recovery incomplete | `tests/box/marketDataStateMachine.test.mjs:98` (partial recovery keeps SYNCHRONIZING) | — |
| 15 | Processing queue overload | `tests/box/boundedQueue.test.mjs` (overload raises signal, never drops order events) | — |
| 16 | Broker authentication expires | `tests/box/orderStreamConsumer.test.mjs:327` (AUTH_EXPIRED perms); `tests/box/marketDataStateMachineWiring.test.mjs:46` | — |
| 17 | Process restarts with live working orders | `tests/pg/orderStreamRestart.test.mjs` (durable re-adoption against REAL PostgreSQL) | — |
| 18 | PostgreSQL fails BEFORE a broker mutation | Ordering only: `tests/box/orderManager.test.mjs:274` (CREATED/SUBMITTING durable before transport). **GAP: no persistence-FAILURE injection asserting 0 POST.** | `tests/box/persistenceFailureBoundary.test.mjs` |
| 19 | PostgreSQL fails AFTER a broker mutation | `tests/box/crashRecovery.test.mjs` (crash after POST/fill via restart+reconcile). **GAP: no in-flight after-POST persistence throw asserting exposure preserved + surfaced.** | `tests/box/persistenceFailureBoundary.test.mjs` |
| 20 | Atlas projection unavailable | `tests/projector/resilience.test.mjs` (LOAD-BEARING: Mongo outage does not block PG tx; backlog grows) | — |

## The five named integration proofs (PRODUCTION objects, not doubles)

| # | Named proof | Proving test (production object exercised) |
|---|---|---|
| 1 | Stream updates actually resolve production order waiters | `tests/box/orderStreamRealWaiter.test.mjs` — REAL `KiteBrokerAdapter.submitOrder → waitForResolution`; stream fill via `applyOrderUpdate`; asserts `transport.getOrderCalls() === 0` |
| 2 | Rate exhaustion actually prevents prohibited transmission | `tests/box/rateBudgetProductionWiring.test.mjs` — REAL `KiteBrokerAdapter`/`DhanBrokerAdapter` + counting transport; asserts `placeCalls()`/`calls.place` does not increase |
| 3 | Missing required funds/margin evidence actually blocks entry | `tests/box/economicAdmissionWiring.test.mjs` — REAL `CentralBoxExecutionGateway`; asserts `outcome_class REFUSED_BEFORE_SUBMIT`, `submitted.length === 0` |
| 4 | Real execution events actually increment the outcome funnel | `tests/box/funnelProductionWiring.test.mjs` — REAL `BoxScanner` + `BoxExecutionSimulator` + `ExecutionFunnel` via production hooks |
| 5 | Final-send coherence blocks the queued regression | `tests/box/defectCSendBoundaryCoherence.test.mjs:71` — REAL gateway→manager→adapter; coherence good at enqueue, degraded during pacing → 0 POST |

The revert-proof for each of these five is recorded in the "Revert proofs" section below.
