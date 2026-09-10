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
