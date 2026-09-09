# EVIDENCE-transport.md — failing-first proof per defect

Procedure for each defect: the new test(s) were committed first, then the ORIGINAL source file(s)
were restored from `git show main:<path>`, rebuilt (`npm run build`), and the specific test run to
capture the failure; then the fix was restored, rebuilt, and the test re-run to capture the pass.
All network I/O is mocked (injected `fetch` / fake client) — no test contacts a real broker.

Baseline on unmodified main: `node --test "tests/**/*.test.mjs"` → 1742 tests, 1742 pass, 0 fail,
0 skipped. After the fix: 1757 tests, 1757 pass, 0 fail, 0 skipped (1742 + 15 new).

---

## DEFECT 2 — Dhan immediate terminal response accounting
Test: `tests/box/defect2DhanTerminalAccounting.test.mjs`
Source restored to original: `src/box/dhanBrokerAdapter.ts`

### BEFORE (original `dhanBrokerAdapter.ts`) — FAIL (verbatim)
```
=== DEFECT 2 ON ORIGINAL (expect FAIL) ===
ℹ tests 6
ℹ pass 1
ℹ fail 5

✖ an immediate TRADED with NO cumulative quantity is NOT a COMPLETE-with-0 execution
✖ a TRADED placement whose evidence CANNOT be obtained stays UNCERTAIN, not COMPLETE
✖ a TRADED label with a SHORT verified fill is PARTIALLY_FILLED, never COMPLETE
✖ a CANCELLED placement with a NONZERO verified fill is reconciled, not treated as flat
✔ a REJECTED placement with a CONFIRMED zero fill is a clean rejection
✖ a delayed order book (TRADED visible only on the second read) is still accounted from evidence

  AssertionError [ERR_ASSERTION]: the quantity came from an order/trade read, not the label
```
(The original derives `order.state = dhanOrderState(placed.orderStatus, 0, req.quantity)` — an
immediate `TRADED` collapses to COMPLETE with filled_quantity 0, no order/trade read. The one
passing case is the REJECTED placement, which the original also rejects.)

### AFTER (fix restored) — PASS (verbatim)
```
=== DEFECT 2 ON FIX (expect PASS) ===
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

---

## DEFECT 3 — final guard must be at the HTTP send boundary
Test: `tests/box/defect3SendBoundaryGuard.test.mjs`
Sources restored to original: `src/brokers/dhan/http.ts`, `src/brokers/dhan/client.ts`,
`src/box/dhanBrokerAdapter.ts`, `src/box/kiteBrokerAdapter.ts`

### BEFORE (originals) — FAIL (verbatim)
```
=== DEFECT 3 ON ORIGINAL (expect FAIL) ===
✔ DHAN: a local refusal at the send boundary transmits NO POST (real HTTP queue, fake fetch)
✔ DHAN: disarming while a POST is QUEUED behind pacing still results in NO fetch
✖ DHAN: NO async wait sits between the guard and the fetch (structural)
✔ KITE: a local refusal after the token await transmits NO POST (real transport, fake fetch)
✖ KITE: the guard fires AFTER the async token resolution, immediately before fetch
ℹ tests 5
ℹ pass 3
ℹ fail 2

  AssertionError [ERR_ASSERTION]: no microtask interleaved between guard and fetch — the boundary is synchronous
  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:   (the token was resolved BEFORE the guard)
```
WHY these two fail on the original and the "no POST" ones do not: on the original the guard runs
inside the ADAPTER pacer, BEFORE the lower Dhan HTTP queue+pacing sleep (Dhan) and BEFORE the
transport's token-resolution await (Kite). A thrown refusal therefore still prevents the call — so
the three "refused ⇒ no POST" checks pass on the original too. The DISTINGUISHING property is the
async-wait WINDOW between guard and send: the structural microtask-ordering test (Dhan) and the
token-await-ordering test (Kite) prove the window existed on the original and is closed by the fix.

### AFTER (fix restored) — PASS (verbatim)
```
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

---

## DEFECT 4 — end-to-end deadlines
Test: `tests/box/defect4EndToEndDeadlines.test.mjs`
Sources restored to original: `src/brokers/dhan/http.ts`, `src/brokers/dhan/client.ts`,
`src/box/dhanBrokerAdapter.ts`

### BEFORE (original `http.ts`) — FAIL by UNBOUNDED HANG (verbatim)
```
=== DEFECT 4 ON ORIGINAL http.ts (expect FAIL/HANG-bounded) ===
✖ tests/box/defect4EndToEndDeadlines.test.mjs (60021.456893ms)
ℹ tests 1
ℹ pass 0
ℹ fail 0
```
The run was killed by a 60s `timeout`. This IS the defect: the original clears the AbortController
timer the instant headers arrive, then `await res.text()` is unbounded — the "stalled RESPONSE
BODY" test never resolves and the whole file hangs. (A stalled body on a real socket would hang the
transport identically.)

### AFTER (fix restored) — PASS, promptly (verbatim)
```
=== DEFECT 4 ON FIX (expect PASS) ===
ℹ tests 4
ℹ pass 4
ℹ fail 0
```

---

## Post-restore integrity check
After restoring all fixes, `git diff --stat` against HEAD was EMPTY (the working tree exactly
matches the committed fix), and the full suite was green:
```
ℹ tests 1757
ℹ pass 1757
ℹ fail 0
ℹ skipped 0
```
