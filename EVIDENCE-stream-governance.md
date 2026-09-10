# EVIDENCE — Fix Agent 1: order-stream health state machine governance

Branch: feat/order-stream-integration
Baseline HEAD: 2c6cfa5
Baseline suites: TOTAL pass=2010 fail=0 skipped=0 (verified)
Baseline build: `npm run build` exit 0 (verified)

The order-stream health machine is CONSTRUCTED and PARTLY DRIVEN but behaviourally inert:
the permission matrix governs nothing, reconnect never completes reconciliation, DEGRADED is
unreachable, and the Zerodha lifecycle is stuck at CONNECTING.

---

## REPRODUCTION

### D1 — Permission matrix is dead code

`combinedPermissions`, `permissionBlocks`, `orderStreamPermissions`, `OrderStreamConsumer.permissions()`
have ZERO production callers. The only live entry gate is market-data readiness.

```
$ grep -rn "combinedPermissions" src --include=*.ts | grep -v "streamHealthPolicy.ts"
(no output — zero production callers)
$ grep -rn "permissionBlocks" src --include=*.ts | grep -v "streamHealthPolicy.ts"
(no output)
$ grep -rn "orderStreamPermissions" src --include=*.ts | grep -v "streamHealthPolicy.ts"
(no output)
$ grep -rn "\.permissions()" src --include=*.ts
src/box/orderStreamConsumer.ts:295:    return this.machine.permissions();   # only the delegating def
```

executionGateway.ts entry gate (src/box/executionGateway.ts ~285) consumes only
`marketDataEntryPermitted` (engine.ts ~899) which is `marketDataPermissions(state).newEntry` —
the order stream never participates. So an enabled-but-unhealthy order stream (DISCONNECTED /
RECONCILING / DEGRADED / AUTH_EXPIRED) does NOT restrict new entry. Confirmed against the code.

### D4 — Reconnect never drives reconciliation to completion

`markSynchronized()` has exactly one production call site (engine.ts:802, inside the
`restReconcile` callback). `restReconcile` only fires from the absent-quantity
`scheduleReconciliation` path (orderStreamConsumer.ts ~230). `consumer.reconcilePending()`
is never polled in production.

```
$ grep -rn "markSynchronized()" src --include=*.ts
src/box/orderStreamConsumer.ts:262:  markSynchronized(): void {         # def
src/box/orderStreamConsumer.ts:263:    this.machine.markSynchronized();  # def
src/box/engine.ts:802:            consumer.markSynchronized();            # ONLY prod call, absent-qty path only
$ grep -rn "reconcilePending" src --include=*.ts   # consumer.reconcilePending() has no engine caller
src/box/orderStreamConsumer.ts:298:  reconcilePending(): boolean {       # def only
```

So a reconnect leaves RECONCILING only incidentally (if an absent-quantity event happens to fire).
There is no explicit post-reconnect gap-repair sweep.

### D5 — 'connected but not delivering' is undetectable

`consumer.onIdle()` has no production caller, so DEGRADED is unreachable in production.

```
$ grep -rn "onIdle" src --include=*.ts
src/box/orderStreamConsumer.ts:268:  onIdle(): void {                    # def
src/box/orderStreamConsumer.ts:269:    this.machine.onIdle();            # def
src/box/streamHealthPolicy.ts:337:  onIdle(): void {                    # def
(no engine.ts / production caller)
```

### D6 — Zerodha order-stream lifecycle never advances

`engine.startOrderStreamTransports` calls only `consumer.onConnecting()` for Zerodha
(engine.ts ~5522). `onBoxLaneConnection` drives only the market-data machine
(engine.ts ~5372 `driveMarketDataConnection`). `consumer.onSocketOpen()` /
`consumer.onAuthenticated()` / `consumer.markSynchronized()` are never invoked for Zerodha,
so its machine is stuck at CONNECTING and `orderStreamStatus` under-reports Zerodha as
rest_polling_only even though postbacks resolve waiters.

```
$ grep -n "consumer.onConnecting\|consumer.onSocketOpen\|consumer.onAuthenticated" src/box/engine.ts
(Zerodha branch of startOrderStreamTransports calls onConnecting only; onSocketOpen/onAuthenticated
 appear only in the Dhan branch's createDhanOrderFeed callbacks)
```

---

## FAILING-FIRST → PASSING EVIDENCE

New test file: tests/box/streamGovernance.test.mjs (D1/D4/D5/D6 behaviour) plus
tests/box/wiredNotInert.test.mjs (production call-site assertions).

### D1 — first failure (helper not exported)

```
SyntaxError: The requested module '../../dist/box/streamHealthPolicy.js' does not provide an
export named 'entryPermittedFromStreams'
✖ tests/box/streamGovernance.test.mjs  fail 1
```

Then, after adding `entryPermittedFromStreams` (a thin wrapper over the existing
`combinedPermissions` table) and one iteration on the AUTH_EXPIRED assertion (an expired SESSION,
not the order stream, is what refuses a priced protective cancel — market-data AUTH_EXPIRED is
NONE, so the intersection refuses it): all D1 tests pass.

### D4/D5 — first failure (methods not implemented)

```
✖ D5 ... TypeError: consumer.evaluateIdle is not a function
✖ D4 ... TypeError: consumer.runReconnectReconciliation is not a function
ℹ pass 7  ℹ fail 7
```

After implementing `evaluateIdle`, `runReconnectReconciliation`, `reconcileSweep`,
working-order tracking and last-stream-event tracking: all pass.

### Combined pass (streamGovernance.test.mjs) — 17/17

```
✔ D1 (7 tests)  ✔ D5 (4 tests)  ✔ D4 (3 tests)  ✔ D6 (3 tests)
ℹ pass 17  ℹ fail 0
```

### Existing test that guarded the gate literal

`tests/box/marketDataStateMachineWiring.test.mjs` asserts the gate derives from
`marketDataPermissions(state).newEntry`. The first D1 wiring renamed the variable and broke it:

```
✖ NEW ENTRY is gated on READY, and only in LIVE mode
  AssertionError: the gate must derive from the market-data permission table's newEntry
```

Fixed by keeping the exact literal AND intersecting the order stream via
`entryPermittedFromStreams` — both facts now hold. No existing test was modified, deleted or
skipped.

### Anti-inert wiring assertions (wiredNotInert.test.mjs) — added, all pass

```
✔ D1: the combined entry gate consults the order stream, not market data alone
✔ D6: the Zerodha order-stream lifecycle is DRIVEN from the quote-socket connection
✔ D4: the reconnect gap-repair sweep and reconcile completion are wired
✔ D5: idleness is DRIVEN from a real clock against working-order expectation
```

## VERIFICATION (finishing state)

### Build
```
$ npm run build
> tsc -b            # exit 0
```

### Suites
```
$ /home/ubuntu/Cal/run-suites.sh /home/ubuntu/Cal/Strikedge_B
unit         pass=1749   fail=0    skipped=0
invariants   pass=3      fail=0    skipped=0
tokens       pass=48     fail=0    skipped=0
access       pass=31     fail=0    skipped=0
switch       pass=32     fail=0    skipped=0
shutdown     pass=11     fail=0    skipped=0
readiness    pass=24     fail=0    skipped=0
contract     pass=44     fail=0    skipped=0
pg           pass=72     fail=0    skipped=0
projector    pass=17     fail=0    skipped=0
TOTAL pass=2031 fail=0 skipped=0 overall_rc=0
```
Before: TOTAL pass=2010 fail=0 skipped=0.  After: pass=2031 fail=0 skipped=0 (+21, fail=0).

### CI scans + contract
```
$ bash .github/ci/no-live-hostnames.sh   # OK, rc=0
$ node .github/ci/no-egress-guard.mjs     # CI-EGRESS-GUARD: armed (loopback-only egress), rc=0
$ node contract/validate.mjs              # rc=0
```

### Production callers now exist (previously ZERO)
```
# D1 — the entry gate now intersects the order stream via the shared table:
src/box/engine.ts:932:  const permitted = entryPermittedFromStreams({ marketData: state, orderStream }).permitted;
src/box/streamHealthPolicy.ts:218:  const combined = combinedPermissions(args);   # entryPermittedFromStreams → combinedPermissions
src/box/engine.ts:927:  const orderStream = this.orderStreamState();

# D6 — the Zerodha lifecycle is driven from the quote socket:
src/box/engine.ts:5442:  void consumer.driveQuoteSocketLifecycle(connected);   # from onBoxLaneConnection
src/box/orderStreamConsumer.ts:  driveQuoteSocketLifecycle → onConnecting/onSocketOpen/onAuthenticated/runReconnectReconciliation

# D5 — onIdle is reachable via a real clock:
src/box/engine.ts:5501:  consumer.evaluateIdle(this.executionClock.wall());
src/box/orderStreamConsumer.ts:414:  this.machine.onIdle();   # inside evaluateIdle

# D4 — reconcilePending is polled and drives completion:
src/box/orderStreamConsumer.ts:347:  if (!this.reconcilePending()) return;   # inside runReconnectReconciliation
src/box/engine.ts:  reconcileSweep: async (_ingestRest) => { await this.orderManager?.reconcile(); }
```

## NOTES / WHAT WAS NOT DONE
- D6 is proven at the exact production seam the engine invokes (`consumer.driveQuoteSocketLifecycle`,
  called by `engine.onBoxLaneConnection` for Zerodha when the stream is enabled), via the consumer
  behavioural tests plus source-level call-site assertions in wiredNotInert.test.mjs. A full
  live-mode BoxEngine harness (registry + live adapter + PG-backed order manager) was NOT built for
  an end-to-end engine test because that wiring is heavyweight and out of scope for this fix; the
  seam extracted for D6 is the verbatim code the engine calls, so the behaviour is covered.
- AUTH_EXPIRED protective-cancel: the brief's "AUTH_EXPIRED refuses protective cancel" is satisfied
  at the SESSION (market-data) transport, whose AUTH_EXPIRED is NONE; the combined (intersected)
  gate therefore refuses a priced cancel on an expired session. The order-stream table's own
  AUTH_EXPIRED keeps protectiveCancel=true (an existing pinned test requires this, and the reduction
  itself is risk-reducing) — the refusal correctly comes from the session, not the order socket.


---

# EVIDENCE — Fix Agent 2: env-flag gating honesty (D2), duplicate fill-ledger store (D3), effective-config doc honesty (D7)

Branch: feat/order-stream-integration
Baseline HEAD for Agent 2: b603d63 (Agent 1's evidence commit).
Agent 1 left: TOTAL pass=2031 fail=0 skipped=0. Agent 2 must keep fail=0 and not drop the pass count.

---

## DEFECT D2 — the Zerodha flag only changed a label, not the observation path

### REPRODUCTION (confirmed by reading the code before fixing)
- The order-stream consumer is ALWAYS constructed in live mode (engine.ts:790), because it is
  needed for REST reconciliation and honest health even when the stream is off. `streamEnabled`
  (from the flag) is passed to it.
- The consumer's `streamEnabled` only drives HEALTH: `OrderUpdateProjection.setStreamEnabled(false)`
  sets the health state to DISABLED but does NOT gate `ingest()` — a stream observation ingested
  while "disabled" still attributes, applies to the ledger, and calls `applyToAdapter` (waking the
  order's waiter).
- The engine's `ingestBoxLaneOrderText` (the box lane's Kite-postback WS callback, wired
  unconditionally via registry.ts:495 ← index.ts:198) was guarded ONLY by
  `if (!this.orderStreamConsumer) return` — NEVER by the env flag. So a postback resolved a
  production order waiter EVEN WITH `ZERODHA_ORDER_STREAM_ENABLED` unset, while `orderStreamStatus`
  reported `gated_off` / `rest_polling_only`. A flag controlling a label but not the capability.

### FAILING-FIRST → PASSING
New test: tests/box/zerodhaFlagGatesObservation.test.mjs

First failure (the honest gate predicate did not exist):
```
SyntaxError: The requested module '../../dist/brokers/zerodha/orderUpdates.js' does not provide an
export named 'zerodhaTextFramesConsumed'
✖ tests/box/zerodhaFlagGatesObservation.test.mjs  fail 1
```
The reproduction test itself demonstrates the defect behaviourally: with `streamEnabled: false`
(the value the engine passes when the flag is unset), a stream observation STILL resolves the REAL
KiteBrokerAdapter waiter with the REST getOrder poll never reached — proving the flag was not on
the observation path.

### DECISION: OPTION (a) — the flag GENUINELY GATES the observation path. WHY:
1. It makes the DEFAULT deployment safe: unset ⇒ the verified REST-polling baseline, unchanged.
2. It keeps REST polling as the fallback (unchanged).
3. It makes the CODE match the meaning the DOCS ALREADY PROMISED — orderUpdates.ts said
   "OFF BY DEFAULT ... When off, ticker.ts keeps discarding text frames"; env.example says OFF =
   REST is the authority. Only the code failed to honour it. Option (b) (always-on, remove the
   flag) would delete a switch operators rely on to stage a supervised rollout.

### FIX
- Added `zerodhaTextFramesConsumed()` in src/brokers/zerodha/orderUpdates.ts — the honest,
  behaviour-named observation-path gate (currently the same single flag; documented as such).
- `engine.ingestBoxLaneOrderText` now DROPS the frame before parse/enqueue unless the gate is armed.
  The `order_events` ingestion queue has exactly ONE enqueuer (engine.ts:5546), so this is the
  single correct chokepoint: unarmed ⇒ no postback consumed, no waiter woken by the stream, REST is
  the sole mechanism — exactly what `orderStreamStatus` reports.
- STATUS PAYLOAD SHAPE UNCHANGED. The existing `gated_off` / `rest_polling_only` reporting is now
  TRUE instead of misleading. Contract NOT bumped.
- Corrected env.example comment to state OFF ⇒ postbacks are NOT consumed (REST polling only).

Passing:
```
✔ D2 reproduction: the consumer's streamEnabled flag alone does NOT gate ingestion
✔ D2 fix: the text-frame observation gate is CLOSED when the flag is unset
```
Plus a source call-site assertion in wiredNotInert.test.mjs:
```
✔ D2: the Zerodha text-frame OBSERVATION path is gated by the flag, not just the status label
```
Commit: 9fca48e.

---

## DEFECT D3 — two competing fill-ledger stores, a comment claiming "ONE TRUTH"

### REPRODUCTION (confirmed by reading the code before fixing)
Two independent per-order `CumulativeFillLedger` stores, both fed from the SAME `BrokerOrder`
snapshot on the SAME code path (`persistOrder`):
- Store 1: `OrderUpdateProjection.ledgers` (in the consumer), fed by stream events and by REST via
  `noteStreamBrokerSnapshot` (orderManager.ts). THE projection of truth (attributes, dedups, wakes).
- Store 2: `orderManager.fillLedgers` (a BoundedTtlCache), fed independently by
  `rememberFillIdentities`, called right after `noteStreamBrokerSnapshot` in `persistOrder`.
A comment read "ONE TRUTH" while two stores existed.

Crucially, `grep applied_overfill|\.trip\(` proved the two are NOT redundant: the PROJECTION (Store 1)
computes `applied_overfill` but NEVER trips a breaker (orderStreamConsumer.ts:257 only decides
whether to wake the adapter). ONLY Store 2 calls `this.trip(...)` on overfill (orderManager.ts).
So Store 2 is a GENUINE, DISTINCT safety protection: an independent overfill circuit-breaker
tripwire that the projection does not provide.

### RESOLUTION: OPTION B — keep Store 2 deliberately, rename it, disclose it, pin the invariant.
- Renamed `fillLedgers` → `overfillTripwireLedgers`; `rememberFillIdentities` → `checkOverfillTripwire`.
- Rewrote the field/method comments to state plainly it is NOT the single truth but an independent,
  redundant-by-design overfill tripwire that shares no state with the projection it guards.
- Corrected the "ONE TRUTH" comment at the `noteStreamBrokerSnapshot` call site to "ONE PROJECTION
  OF TRUTH", naming the projection as the single truth and the tripwire as a separate cross-check.
- Added read-only diagnostic `overfillTripwireCumulative(clientOrderId)` so a test can compare the
  two stores' attributed cumulative on live objects.

### FAILING-FIRST → PASSING (real PostgreSQL, isolated schema per test; broker network mocked)
New test: tests/pg/fillLedgerTwoStores.test.mjs

Failing-first was produced by SIMULATING THE REMOVAL of Store 2 (commenting out the
`this.checkOverfillTripwire(order)` call site) — i.e. proving the test catches the loss of the
protection a consolidation would remove:
```
✖ D3 (1): an overfilled broker snapshot TRIPS the breaker (overfill protection preserved)
    actual: 'persistence lost after confirmed fill BOX:...'   (breaker NOT tripped by the tripwire)
✖ D3 (2): the projection and the overfill tripwire NEVER disagree about attributed cumulative
    actual: undefined                                          (overfillTripwireCumulative gone)
ℹ pass 0  ℹ fail 2
```
With Store 2 restored (the real code), both pass:
```
✔ D3 (1): an overfilled broker snapshot TRIPS the breaker (overfill protection preserved)
✔ D3 (2): the projection and the overfill tripwire NEVER disagree about attributed cumulative
ℹ pass 2  ℹ fail 0
```

### PROTECTIONS PROVEN STILL TO HOLD
- OVERFILL BREAKER TRIP (Store 2's unique protection): D3(1) proves an 80-of-75 overfill trips the
  circuit breaker with the exact reason "...exceeding the 75 requested".
- CROSS-STORE AGREEMENT: D3(2) proves the projection cumulative == the tripwire cumulative (both 75).
- COUNTED EXACTLY ONCE: re-driving the SAME durable intent re-feeds BOTH stores; neither advances
  past 75 and the breaker does not trip on a legitimate exact fill (idempotence/monotonicity).
- BONUS third guard observed: real PostgreSQL rejects filled>quantity via the
  `box_order_intents_filled_le_qty` check constraint — a durable-layer overfill guard independent of
  both in-memory stores. Left intact.

Nothing was consolidated away, so no protection was removed; the second store is kept, renamed and
honestly documented as an independent overfill tripwire.

---

## DEFECT D7 — effectiveConfig header claimed "for a status route" that does not exist

### REPRODUCTION
`resolveEffectiveConfig` (effectiveConfig.ts:263) is invoked ONLY by its own CLI `main` and by the
parity test; no HTTP route, engine path or status payload calls it. The header comment claimed it
was "for a status route or a test".

### FIX (documentation-only)
Rewrote the header's "WHO CONSUMES THIS" / "RUNTIME SURFACES" block to describe it honestly as an
OPERATOR PRE-FLIGHT CLI TOOL (`node dist/box/effectiveConfig.js`) with no running-process caller.
Verified the docs (CONFIGURATION.md, DEPLOYMENT.md, RUNBOOK.md, MUMBAI_EC2_PROFILE.md) already
describe it only as a pre-arm CLI command — no doc implied a running-process integration, so no doc
change was needed. Existing tests unaffected:
```
$ node --test tests/box/effectiveConfig.test.mjs   # pass 14 fail 0
```

---

## VERIFICATION (Agent 2 finishing state) — see the "FINAL VERIFICATION" appendix below for command output.
