# EVIDENCE — Four-leg book coherence (failing-first)

Branch: `work/coherence` (forked from `fix/live-execution-hardening`).
Date: 2026-09-09. No real broker endpoint or socket was contacted at any point;
`manager.submit` is an in-memory stub and the quote store is a plain `BoxQuoteStore`.

## The defect (re-verified on current code before changing anything)

`BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS`:
- defined `src/box/config.ts:1106` (default 250; `.env.example` set it to 0),
- exposed `src/box/executionPolicy.ts:55-56`,
- consumed in EXACTLY ONE place before this change: the paper simulator
  (`src/box/executionSimulator.ts`, the `simulateLeggingEntry` skew gate).

`grep` for the constant across the tree returned matches ONLY in `config.ts`,
`executionPolicy.ts` and `executionSimulator.ts` — never in `executionGateway.ts`.
So the limit was enforced in the PAPER simulator only. The LIVE gateway
(`CentralBoxExecutionGateway.simulateLeggingEntry`) admitted four books that were
each individually fresh (< 15,000 ms `quoteMaxAgeMs`) even when they were 8,000 ms
apart, because per-leg freshness cannot see cross-leg skew.

## Failing-first procedure

A throwaway probe (`tests/box/coherenceEvidenceProbe.test.mjs`, and an
exchange-timestamp variant `coherenceEvidenceProbeExch.test.mjs`) drove ONE live
entry whose four books were individually fresh but 8,000 ms dispersed. The probe
imports only the live gateway — never the new coherence module — and asserts the
PRE-FIX behaviour: all four legs submitted (`submitted.length === 4`) and the box
opened (`res.ok === true`). Both probes were deleted after capture; the kept proof
lives in `tests/box/executionCoherence.test.mjs`.

### Step 1 — PRE-FIX (restored via `git show fix/live-execution-hardening:<path>`)

The four owned source files were restored from the integration branch and the (new)
coherence module was moved aside, then `npm run build` (clean), then the probes ran.

RECEIVE-time dispersion probe — VERBATIM:

```
=== PROBE AGAINST PRE-FIX CODE (expect PASS: defect admits 8s dispersion) ===
✔ PRE-FIX EVIDENCE: live gateway admits an 8,000 ms cross-leg-dispersed book (6.364617ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 100.570034
```

EXCHANGE-timestamp dispersion probe — VERBATIM:

```
=== PRE-FIX EXCHANGE PROBE (expect PASS) ===
✔ PRE-FIX EVIDENCE: live gateway admits 8000ms EXCHANGE-dispersed book (7.008596ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 129.728949
```

Both PASS: the pre-fix live gateway admits an 8,000 ms cross-leg-dispersed book and
transmits all four legs, WITH exchange timestamps and WITHOUT them.

### Step 2 — POST-FIX (fix restored, coherence module rebuilt)

Same RECEIVE-time probe run against the FIXED gateway — VERBATIM:

```
=== PROBE AGAINST FIXED CODE (expect FAIL: fix rejects, submits 0) ===
✖ PRE-FIX EVIDENCE: live gateway admits an 8,000 ms cross-leg-dispersed book (7.349071ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 99.744179

✖ failing tests:

test at tests/box/coherenceEvidenceProbe.test.mjs:43:1
✖ PRE-FIX EVIDENCE: live gateway admits an 8,000 ms cross-leg-dispersed book (7.349071ms)
  AssertionError [ERR_ASSERTION]: PRE-FIX defect: all four legs were submitted despite 8s dispersion

  0 !== 4

    ... actual: 0, expected: 4, operator: 'strictEqual'
```

The probe now FAILS with `0 !== 4`: the fixed gateway rejects the incoherent book
and submits nothing. The inversion (PRE-FIX pass → POST-FIX fail on the same probe)
is the proof the fix changed LIVE behaviour at exactly this admission point.

## Kept proof (the assertions that stay green)

`tests/box/executionCoherence.test.mjs` — the 8,000 ms case is REJECTED under a
suitably configured LIVE policy, BOTH with exchange timestamps and without
(receive-time only), while a coherent book is still ADMITTED:

```
✔ LIVE gateway REJECTS 8,000 ms cross-leg dispersion — WITHOUT exchange timestamps
✔ LIVE gateway REJECTS 8,000 ms cross-leg dispersion — WITH exchange timestamps
✔ LIVE gateway ADMITS a coherent book (four legs received within ~120ms)
✔ 8,000 ms cross-leg RECEIVE dispersion is REJECTED (no exchange timestamps)
✔ 8,000 ms cross-leg EXCHANGE dispersion is REJECTED (all exchange timestamps present)
✔ a coherent book is ADMITTED (the fix does not reject everything)
✔ PER-LEG age limit is enforced even when the four legs are tightly clustered
✔ a MISSING exchange timestamp never itself rejects; it falls back to receive-time
✔ a missing BOOK (no received_at) fails closed as missing_book
✔ a DEPTHLESS update fails closed as depthless_book
✔ a RECONNECT generation is invalidated: a leg from a superseded generation is refused
✔ legs that SPAN two generations are refused even without a caller-supplied current generation
✔ a CLOCK anomaly (book stamped in the future) is refused
✔ an exchange timestamp implausibly AHEAD of receive time is refused (future skew)
✔ a small exchange-ahead skew (coarse 1s stamps) is TOLERATED
✔ DUPLICATE/STALL: a re-check where no book advanced and all are at/over age is refused
✔ a re-check where a book DID advance is admitted (not treated as a stall)
✔ LIVE: a 0 receive-dispersion limit is IMPOSSIBLE-TO-SATISFY, not a silent bypass
✔ LIVE with explicit opt-out: a 0 receive-dispersion limit DISABLES the receive gate
✔ PAPER: a 0 dispersion limit disables the cross-leg gate (historical behaviour preserved)
✔ PROTECTIVE REDUCTION is NOT blocked when four-leg coherence has deteriorated
✔ broker timestamp semantics are documented with sources and a verification date
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

## Suite counts (no reduction from the branch-point baseline of 1817)

- `node --test "tests/box/*.test.mjs" "tests/invariants/*.test.mjs"`:
  tests 1561, pass 1561, fail 0, skipped 0.
- Full `npm test` with `DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge`:
  **tests 1839, pass 1839, fail 0, skipped 0, todo 0** (1817 baseline + 22 new).
