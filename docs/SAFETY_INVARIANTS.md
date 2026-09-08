# Box Safety Invariants — Audit & Durable Checklist

Auditor pass over the 20 "must-not-regress" Box safety invariants, looking for the defect class
**"a claim that nothing verifies"**. Method: for each invariant, locate the enforcement in `src/`
and the test that actually *asserts* it (not merely names it), then classify. Test *existence* was
never treated as proof — the assertions were read.

Baseline at audit: unit 1477, tokens 47, access 19, switch 14, shutdown 11, pg 30, projector 15 =
**1613**, 0 fail, 0 skip. After this audit: **+3** in `tests/invariants/` (see invariant 20). No
production code changed — every invariant was found already enforced.

Legend: **E+T** enforced+tested · **E,U→+T** was enforced-but-untested, test added here ·
**NE** not enforced · **N/A** not applicable.

| # | Invariant | Class | Enforcement (file:line) | Test (file) |
|---|-----------|-------|-------------------------|-------------|
| 1 | Paper mode can never call a mutation-capable broker adapter | **E+T** | `executionGateway.ts` fork `if (this.mode !== "live") return simulator…`; engine constructs a manager only in `live` mode (`engine.ts:640`); `executionSimulator` refuses a live entry (defense-in-depth) | `paperNeverReachesBroker.test.mjs` — poison manager + **positive control** proves the poison is reachable, so paper silence is meaningful |
| 2 | Live requires BOTH `BOX_EXECUTION_MODE=live` AND `BOX_LIVE_TRADING_ENABLED=true` | **E+T** | `config.ts` `loadBoxConfig` (unknown modes fail closed, no paper fallback) | config.test.mjs: "LIVE is REFUSED when the deployment gate is off", "live mode loads only when BOX_LIVE_TRADING_ENABLED=true", "unknown BOX_EXECUTION_MODE values fail closed" |
| 3 | Even then, startup remains runtime-disarmed | **E+T** | `engine.ts:646` hardcodes `controls: { entryEnabled:false, liveOrderEnabled:false, emergencyFlatten:false }` at manager construction | tradingSession/liveModeTransition: "a fresh deployment loads as IDLE and refuses entry until armed", "the three permissions are INDEPENDENT: arming one never implies another" |
| 4 | Entering the site passcode does not arm live trading | **E+T** | Access gate (site passcode) is fully separate from the three runtime controls + full-admin `x-admin-token` arm; `LiveArm` requires deployment capability, not a session | access `primitives/gate` suites; `singleBroker.test.mjs`: "session state is never derived from admin authentication"; `liveModeTransition.test.mjs`: "a UI toggle cannot bypass deployment authorisation at ANY level of quiet", "without deployment capability NO live permission may be armed" |
| 5 | Live orders are LIMIT only | **E+T** | `orderPricing.ts` bounded-LIMIT construction; adapters enforce bounded chase; MARKET is structurally unrepresentable | "REQUIRED 19: bounded LIMIT enforcement still makes a MARKET order unrepresentable"; kiteBrokerAdapter: "Kite adapter enforces bounded LIMIT chase…"; "an unbounded LIMIT envelope is refused before anything is sent" |
| 6 | A normal Box entry is exactly one valid lot across all four instruments | **E+T** | `singleLotInvariant.ts` (`singleLotCandidateViolation`/`exactEntryFillViolation`, all four roles == lot) | singleLotInvariant.test.mjs: "size is always exactly one lot", "entry fills must be exactly one lot per role; overfill truth remains distinguishable" |
| 7 | Four-leg entry is not atomic at broker and is never documented as atomic | **E+T** | `LIVE_EXECUTION.md` "Remaining broker leg risk" states non-atomicity explicitly and repeatedly; no code path claims atomicity | "LIVE_EXECUTION.md documents the paper-vs-live latency distinction" + the doc-driven noArtificialLiveLatency source-audit; residual/recovery suites exercise the non-atomic recovery path (partialEntryRecovery) |
| 8 | The existing hedge-first submission ordering is used | **E+T** | `entrySubmissionOrder.ts` (`entryTransportRank`, hedge-first); `orderManager.ts` `EntryTransportGate` barrier — uncovered SELL waits on all BUY hedge POST round-trips | hedgeFirstEntryOrder.test.mjs: "SHORT_BOX: every BUY hedge reaches the broker before any uncovered SELL", "a rejected BUY hedge stops the dependent uncovered SELLs BEFORE they POST", "a hedge whose submission is AMBIGUOUS also stops the dependent SELL" |
| 9 | A durable intent exists before external submission | **E+T** | `orderManager.ts` CREATED→SUBMITTING expected-state CAS before any POST; deterministic identity persisted first | orderLifecycle/liveEntryOwnershipGuard: "CREATED and SUBMITTING are durable before transport submission"; "ownership lost DURING durable persistence: zero POSTs" (rows exist, terminalized no-POST) |
| 10 | Immediately before every broker POST, the full checklist is revalidated | **E+T** | `liveEntryGuard.ts` `evaluateLiveEntryGuard` (pure, fail-closed) consulted at 5 checkpoints; feed-generation/depth revalidated in adapter pre-POST | liveEntryOwnershipGuard.test.mjs (whole suite): each condition refuses distinctly; "entry DISARMED during pacing: zero POSTs"; "the scanner decision becomes unwanted during pacing: zero POSTs"; "circuit breaker TRIPS during pacing: zero POSTs" |
| 11 | Timeout/ambiguous broker reply is quarantined & reconciled, never blindly resubmitted | **E+T** | Kite/Dhan adapters return `BrokerAmbiguousSubmitError` → `RECONCILIATION_REQUIRED`, no broker id claimed | ambiguousSubmitAdoption.test.mjs: "a 200 with no orderId is ambiguous and reconciles rather than re-POSTing"; "ambiguous submit is durable and never blindly retried" |
| 12 | Only a uniquely matching broker order whose immutable attributes match is adopted | **E+T** | Adapter adoption checks unique tag/client-id + immutable attribute equality; a collision quarantines | ambiguousSubmitAdoption.test.mjs: "a tag match whose immutable attributes disagree is never adopted", "SEVERAL orders sharing our tag are never adopted", "an order already attributed to a different client id is never stolen" |
| 13 | Cumulative fills are monotonic and attributed exactly once | **E+T** | `CumulativeFillLedger` (orderLifecycle.ts): idempotent, never decreases, overfill flagged not clamped; attribution via durable delta | fillAttribution.test.mjs A1–A10 (out-of-order, duplicate, over-reduction, 400 randomised races) |
| 14 | Cancel can race fills; broker truth never rounded down or overwritten | **E+T** | partialEntryRecovery cancel-race plan unwinds the *terminal* cumulative quantity | partialEntryRecovery.test.mjs: "a cancel that RACED a fill is unwound at the larger terminal quantity" (55 not stale 20); crashRecovery "a stale lower broker snapshot cannot rewind the recorded remainder" |
| 15 | Partial exits never over-close or reverse a role | **E+T** | `partialExitPnl`/exit sizing submits only the exact nonzero remainder per role; reductions cannot cross flat | partialExit.test.mjs: "repeated partial fills on one role never over-close", "reductions must use the exact reducing side/quantity and cannot cross flat", "an over-close is quarantined without clamping or changing quantities" |
| 16 | Restart adopts open positions, unresolved intents and residual exposure | **E+T** | Live boot reconciliation (`orderManager.reconcile`) + `partialEntryRecovery` + residual journal; engine adopts before RUN | crashRecovery/residualRecovery/residualFlattenIdentity: "RESTART" family, "a crash after a FULL/PARTIAL fill…", "R8/R9/R10/R11" crash-before/after-POST adoption |
| 17 | Graceful shutdown stops new discovery first; SIGTERM never auto-liquidates | **E+T** | `index.ts:720` shutdown step 1 = "block new Box entry and stop scanner discovery" before HTTP; steps preserve positions; `index.ts:35` "SIGTERM IS NOT AN INSTRUCTION TO LIQUIDATE" | shutdown/coordinator.test.mjs: flatten spy that must never be called **and** source step-name scan for any flatten/liquidate/close verb |
| 18 | Same-contract overlaps serialise & revalidate; unrelated stay concurrent; no global four-leg mutex | **E+T** | `executionCoordinator` exact-contract reservations; `maxConcurrentPerUnderlying` budget does not replace per-contract exclusion; no whole-underlying lock for unrelated contracts | executionCoordinator/underlyingLockCoordinator/durableInstrumentReservations: T7/T8/T10/T11, MP2/MP3/MP4, "the per-underlying budget caps concurrency WITHOUT replacing per-contract exclusion" |
| 19 | One-active-box-per-underlying, entry capital max, session max block NEW ENTRY ONLY | **E+T** | `orderManager.canEnter()` (open-box/quantity limits) is consulted only for `purpose==="ENTRY"` (submit gate `orderManager.ts:794`); `boxCapital`/session/underlyingLock stamp/consult ENTRY only | boxCapital: "the per-Box ₹ cap blocks ENTRY but not an EXIT"; underlyingLock: "the UNDERLYING LOCK blocks entry but not an exit"; tradingSession: "a CONSUMED SESSION BUDGET blocks entry but not an exit" |
| 20 | **THE MOST IMPORTANT ONE** — no entry blocker may prevent a valid reduction of owned exposure | **E, U→+T** | Mechanical: `orderManager.ts:794-799` gates ENTRY on `canEnter()` (all six-plus blockers) but non-ENTRY only on `canManageExposure()` (`orderManager.ts:759`, = `liveOrderEnabled`); coordinator exit path deliberately omits the ownership guard (`executionCoordinator.ts:585`); `flattenResidual` ungated (`executionCoordinator.ts:468`) | See detailed table below |

## Invariant 20 — the six blockers × the four reduction operations

Invariant 20 names six blockers (max Box entry amount; one-active-underlying; session max; scanner
STOP; entry disabled; reservation-authority outage) and four reduction operations that must survive
them all (EXIT; protective cancellation; emergency residual flatten; reconciliation-required
reduction). I mapped every blocker to the operation(s) proven against it.

`tests/box/exitImmunity.test.mjs` was read line-by-line as instructed. It covers **five** of the six
blockers at the coordinator/gateway layer (capital cap, session budget incl. unreadable, underlying
lock, max-open-boxes, durable reservation outage) — for EXIT and residual flatten. It does **not**
cover scanner STOP or entry-disabled — those live in other files:

- **scanner STOP → exit**: `monitor.test.mjs` test 30 ("STOP stops discovery but the monitor keeps
  managing and exiting") — the monitor, not the scanner, drives exits, and it runs regardless of
  RUN/STOP. `engine.ts:10-13` documents DISCOVERY(RUN/STOP) vs MONITORING(always on).
- **entry disabled + open breaker → EXIT & EMERGENCY_RESIDUAL**:
  `liveEntryOwnershipGuard.test.mjs` ("an EXIT is unaffected by ownership loss, disarmed entry and
  an open breaker"; "an EMERGENCY_RESIDUAL reduction proceeds while entry is fully locked down").

### The gap I found and closed

The four reduction operations were covered at the manager layer for EXIT, EMERGENCY_RESIDUAL and
(via `estimateExecutableExit`/reconciliation) reconciliation-required reduction — but **protective
cancellation was NOT** exercised at the order-manager boundary under a disarmed entry / open
breaker. `BoxOrderManager.cancelWorkingBoxOrders()` (`orderManager.ts:942-943`) and a
`purpose:"PROTECTIVE_CANCEL"` `submit()` (`orderManager.ts:797`) are both gated **only** by
`canManageExposure()` — never by `canEnter()` — so the enforcement was already correct; it was the
*verification* that was missing. This is exactly the "a claim that nothing verifies" class: the
`LIVE_EXECUTION.md` "protective cancellation" guarantee had no test at the manager boundary.

Tests added — `tests/invariants/exitImmunityProtectiveCancel.test.mjs` (3 tests, all green):

1. *a PROTECTIVE_CANCEL submit reaches the broker while entry is disarmed and the breaker is open* —
   real POST occurs (`adapter.posts[0].purpose === "PROTECTIVE_CANCEL"`).
2. *cancelWorkingBoxOrders() cancels working legs while entry is disarmed and the breaker is open* —
   real broker cancel issued for the working BOX order.
3. *cancelWorkingBoxOrders() is refused ONLY when live-order authorization itself is withdrawn* —
   the **negative control**: proves the gate is `canManageExposure()` (not an accidental dependence
   on entry state), and that test 2 is not vacuous.

### package.json changed

Added `"test:invariants": "node --test \"tests/invariants/*.test.mjs\""`. **Flagged for
reconciliation** — another agent may also be editing package.json.

## Tests judged and NOT found misleading

Spot-checked for the "green but hollow" pattern that hid the two prior defects. These looked strong
and *are* strong (real assertions, real broker boundary, negative/positive controls):
`paperNeverReachesBroker` (positive control), `liveEntryOwnershipGuard` (asserts on `adapter.posts`
= real POST boundary), `fillAttribution` A1–A10, `partialEntryRecovery` cancel-race (55 not 20),
`ambiguousSubmitAdoption` immutable-mismatch, `shutdown/coordinator` (spy + source scan).

No misleading test was found. No production defect was found — all 20 invariants are enforced; the
sole gap was a missing *verification* for one clause of invariant 20, now closed.
