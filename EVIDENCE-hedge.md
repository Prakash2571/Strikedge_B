# EVIDENCE — hedge quantity barrier (failing-first regression proof)

Branch: `work/hedge`, forked from main `8da7ca47846a64d93499c521772b0747b293e5ee`.

Test file: `tests/box/hedgeQuantityBarrier.test.mjs` (19 tests).

Procedure followed:
1. Committed the new tests.
2. Checked out the ORIGINAL main versions of the five owned `src/box` files
   (`orderManager.ts`, `liveEntryGuard.ts`, `executionGateway.ts`,
   `entrySubmissionOrder.ts`, `executionCoordinator.ts`) and removed the new
   `hedgeCoverageLedger.ts`, then `npm run build && node --test tests/box/hedgeQuantityBarrier.test.mjs`.
   The test file asserts ONLY on `adapter.posts` and the public harness, so it
   compiles and runs unchanged against the old code — it is contract-agnostic.
3. Restored the fixed src from HEAD, rebuilt, re-ran.

The test file was NOT changed between the two runs.

---

## BEFORE — original main src (build clean, tests FAIL)

```
$ npm run build   # OLD src — build clean, BUILD: 0
$ node --test tests/box/hedgeQuantityBarrier.test.mjs

✖ LONG_BOX @c=1: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs (18.081482ms)
✖ LONG_BOX @c=4: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs (5.406056ms)
✖ SHORT_BOX @c=1: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs (4.603762ms)
✖ SHORT_BOX @c=4: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs (1.872452ms)
✖ LONG_BOX: one hedge fully filled, the other CANCELLED/0-fill → NO SELL POSTs (3.287108ms)
✖ SHORT_BOX: one hedge fully filled, the other CANCELLED/0-fill → NO SELL POSTs (3.982134ms)
✖ LONG_BOX: a hedge PARTIALLY filled below its lot → NO full-size SELL POSTs (2.351319ms)
✖ SHORT_BOX: a hedge PARTIALLY filled below its lot → NO full-size SELL POSTs (1.778752ms)
✖ SHORT_BOX: cancel-races-a-partial-fill hedge stays SHORT → SELL blocked, no guessed unwind (2.286506ms)
✔ SHORT_BOX: a cancel that LOSES the race (hedge completes) proves full coverage → SELL authorised (1.541187ms)
✔ LONG_BOX: an AMBIGUOUS hedge submission blocks the dependent SELL (4.023141ms)
✔ LONG_BOX: a hedge returning UNKNOWN (uncertain terminal) blocks the dependent SELL (1.271612ms)
✔ SHORT_BOX: an AMBIGUOUS hedge submission blocks the dependent SELL (0.998015ms)
✔ SHORT_BOX: a hedge returning UNKNOWN (uncertain terminal) blocks the dependent SELL (1.428903ms)
✔ LONG_BOX @c=1: both hedges fully confirmed → both SELLs DO POST (happy path) (1.162703ms)
✔ LONG_BOX @c=4: both hedges fully confirmed → both SELLs DO POST (happy path) (0.81512ms)
✔ SHORT_BOX @c=1: both hedges fully confirmed → both SELLs DO POST (happy path) (1.331412ms)
✔ SHORT_BOX @c=4: both hedges fully confirmed → both SELLs DO POST (happy path) (0.892234ms)
✖ SHORT_BOX: a hedge that fills on the WRONG contract token does not cover the SELL (2.236032ms)
ℹ tests 19
ℹ suites 0
ℹ pass 9
ℹ fail 10
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

✖ failing tests:

test at tests/box/hedgeQuantityBarrier.test.mjs:58:5
✖ LONG_BOX @c=1: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs (18.081482ms)
  AssertionError [ERR_ASSERTION]: no uncovered SELL may POST when both hedges CANCELLED/0-fill; got [{"role":"k2_ce","side":"SELL","client_order_id":"BOX:trade-live-1:ENTRY:k2_ce:entry-1gace6n","purpose":"ENTRY","quantity":75},{"role":"k1_pe","side":"SELL","client_order_id":"BOX:trade-live-1:ENTRY:k1_pe:entry-1gace6n","purpose":"ENTRY","quantity":75}]
  + actual - expected

  + [
  +   [
  +     'k2_ce',
  +     'SELL'
  +   ],
  +   [
  +     'k1_pe',
  +     'SELL'
  +   ]
  + ]
  - []
```

INTERPRETATION. On the old code, when both BUY hedges came back CANCELLED with
zero fills, BOTH uncovered SELL legs (`k2_ce`/`k1_pe` for SHORT_BOX,
`k2_ce`/`k1_pe` shown; `k1_ce`/`k2_pe` for LONG_BOX) were transmitted to the
recording broker — naked short exposure. The 10 failing cases are the confirmed
defect and its close variants (both-cancelled at c=1 and c=4, single-hedge
cancelled, partial-below-required, raced-partial-that-stays-short, and
wrong-contract attribution), across BOTH directions.

The 4 cases that PASS on old code (AMBIGUOUS, UNKNOWN) were already caught by the
old failure classifier, and the 4 happy-path cases already worked. Those are
retained as adjacent-invariant coverage; the 10 failures above are the genuine
failing-first regressions for THIS defect.

---

## AFTER — fixed src (build clean, tests PASS)

```
$ npm run build   # FIXED src — build clean, BUILD: 0
$ node --test tests/box/hedgeQuantityBarrier.test.mjs

✔ LONG_BOX @c=1: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs
✔ LONG_BOX @c=4: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs
✔ SHORT_BOX @c=1: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs
✔ SHORT_BOX @c=4: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs
✔ LONG_BOX: one hedge fully filled, the other CANCELLED/0-fill → NO SELL POSTs
✔ SHORT_BOX: one hedge fully filled, the other CANCELLED/0-fill → NO SELL POSTs
✔ LONG_BOX: a hedge PARTIALLY filled below its lot → NO full-size SELL POSTs
✔ SHORT_BOX: a hedge PARTIALLY filled below its lot → NO full-size SELL POSTs
✔ SHORT_BOX: cancel-races-a-partial-fill hedge stays SHORT → SELL blocked, no guessed unwind
✔ SHORT_BOX: a cancel that LOSES the race (hedge completes) proves full coverage → SELL authorised
✔ LONG_BOX: an AMBIGUOUS hedge submission blocks the dependent SELL
✔ LONG_BOX: a hedge returning UNKNOWN (uncertain terminal) blocks the dependent SELL
✔ SHORT_BOX: an AMBIGUOUS hedge submission blocks the dependent SELL
✔ SHORT_BOX: a hedge returning UNKNOWN (uncertain terminal) blocks the dependent SELL
✔ LONG_BOX @c=1: both hedges fully confirmed → both SELLs DO POST (happy path)
✔ LONG_BOX @c=4: both hedges fully confirmed → both SELLs DO POST (happy path)
✔ SHORT_BOX @c=1: both hedges fully confirmed → both SELLs DO POST (happy path)
✔ SHORT_BOX @c=4: both hedges fully confirmed → both SELLs DO POST (happy path)
✔ SHORT_BOX: a hedge that fills on the WRONG contract token does not cover the SELL
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

---

## Regression suites (fixed src)

```
$ node --test "tests/box/*.test.mjs"
ℹ tests 1480   ℹ pass 1480   ℹ fail 0   ℹ skipped 0   ℹ todo 0

$ node --test "tests/invariants/*.test.mjs"
ℹ tests 3      ℹ pass 3      ℹ fail 0   ℹ skipped 0   ℹ todo 0

$ DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge npm test
ℹ tests 1761   ℹ pass 1761   ℹ fail 0   ℹ skipped 0   ℹ todo 0
```

Baseline on unmodified main was 1742/1742/0/0. After the fix the full suite is
1761/1761/0/0 — the same 1742 kept green, plus the 19 new tests. Nothing was
weakened, skipped or marked todo.
