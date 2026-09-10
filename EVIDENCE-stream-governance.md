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
