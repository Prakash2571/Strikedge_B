# EVIDENCE — broker order-update streams

All runs hermetic: every socket is an injected fake, no real broker endpoint, no real WebSocket.
Verification date: 2026-09-09. Branch: `work/streams`.

## Build

```
$ npm run build      # tsc -b, strict (noEmitOnError, noUncheckedIndexedAccess,
                     # exactOptionalPropertyTypes, verbatimModuleSyntax)
> strikedge_backend@1.0.0 build
> tsc -b
                     # (clean — no output means no type errors, and noEmitOnError
                     #  guarantees dist/ reflects a passing typecheck)
```

## The defect being fixed (verbatim, current code)

`src/ticker.ts` BEFORE this work discarded every Kite text frame — Kite delivers order
updates as TEXT frames on this exact quote socket:

```
// Text frames are postbacks (order updates / error messages) — ignore.
if (typeof data === "string") return;
```

AFTER: `ticker.ts` forwards text frames to an optional `onTextFrame` consumer (inert when
unset, so historical behaviour is preserved unless a caller opts in), and
`brokers/zerodha/orderUpdates.ts` parses them into normalized observations.

The before/after is pinned as a TEST (case 10 below): the same frame that was discarded now
produces an attributed fill observation.

## New / changed test suite — `tests/box/orderUpdateStreams.test.mjs`

```
✔ a stream fill arriving BEFORE the placement HTTP response is applied to the pre-registered ledger
✔ a redelivered stream event with the same identity is ignored exactly once
✔ a REST snapshot that only echoes a stream event's cumulative quantity is deduplicated
✔ an out-of-order event that would REGRESS cumulative quantity is refused
✔ an event for an order this app never placed is dropped, not attributed
✔ an event whose ACCOUNT differs from the registered order is rejected even if the tag matches
✔ a gap while disconnected is repaired from REST on reconnect, not assumed empty
✔ stream loss neither fabricates a terminal state nor disables exposure management
✔ a healthy market-data feed does NOT imply a healthy order stream
✔ a Dhan order_alert publishes cumulative fill evidence from TradedQty alone (no trade-detail fetch)
✔ BEFORE/AFTER: a Kite order text frame that ticker.ts used to DISCARD now yields a real observation
✔ the Dhan order feed is inert until started and reports disconnect to health on drop
✔ the parsers ignore non-order frames and malformed input without throwing
✔ both order streams are OFF unless explicitly enabled via env
ℹ tests 14
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Each required scenario from the brief maps to exactly one of these cases (pre-arrival;
duplicate stream; duplicate stream-vs-REST; regression refused; unowned + foreign account;
disconnect+reconnect+REST reconcile; stream loss does not fabricate/disable; market-data
healthy vs order-stream down; Dhan prompt publication without enrichment; plus the Zerodha
discard defect before/after, transport lifecycle→health, parser robustness, and OFF-by-default).

## Regression — full suite

Baseline at branch point: 1817 tests, 1817 pass, 0 fail, 0 skipped.

```
$ node --test "tests/box/*.test.mjs"
ℹ tests 1549     # was 1536; +13 box-suite tests (case 14 is env-only, still box dir)
ℹ pass 1549
ℹ fail 0
ℹ skipped 0

$ node --test "tests/invariants/*.test.mjs"
ℹ tests 3
ℹ pass 3
ℹ fail 0

$ DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge npm test
tests=1831   pass=1831   fail=0   skipped=0   todo=0   cancelled=0
```

1831 = 1817 baseline + 14 new tests. No existing test was weakened, skipped, or marked todo.
