# SUMMARY — Four-leg book coherence in LIVE execution

Branch `work/coherence` (forked from `fix/live-execution-hardening`). No real
orders, no live trading enabled, no deploy, no production credentials, no test
touched a real broker endpoint or opened a real socket. Web access was used only
for the two official broker docs cited below.

## 1. The defect (re-verified on current code, with file:line evidence)

`BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS`:
- **defined** `src/box/config.ts:1106` (`clampInt(..., 250, 0, 60_000)`; `.env.example`
  set it to `0`),
- **exposed** `src/box/executionPolicy.ts:55-56` (`get maxCrossLegExchangeDispersionMs`),
- **consumed, before this change, in EXACTLY ONE place:** the paper simulator's
  legging skew gate in `src/box/executionSimulator.ts` (`simulateLeggingEntry`).

`src/box/executionGateway.ts` — the LIVE path — never read it. A tree-wide `grep`
for the constant matched only `config.ts`, `executionPolicy.ts` and
`executionSimulator.ts`.

**Consequence:** the live gateway admitted books with 8,000 ms cross-leg dispersion
despite a configured 250 ms limit, because each individual quote age stayed under
the 15,000 ms per-leg allowance (`quoteMaxAgeMs`). Per-leg freshness is blind to
cross-leg skew; only a cross-sectional gate catches it, and that gate was not on the
live path. Proven by failing-first probe in `EVIDENCE-coherence.md`.

## 2. The shared policy and where it is enforced

New module **`src/box/executionCoherence.ts`** — ONE pure, side-effect-free decision
used by BOTH paths so they cannot drift:

- `evaluateBookCoherence(legs, policy, now, {currentGeneration})` — the admission
  decision.
- `recheckBookCoherence(...)` — the same decision plus a duplicate/stall guard, for
  the pre-transmit re-check.
- `evaluateReductionCoherence(leg)` — the deliberately-minimal protective-reduction
  counterpart (see §5).
- `livePolicyFromConfig` / `paperPolicyFromConfig` — build the policy from
  `BoxConfig`, differing ONLY in how a `0` limit is read (§6).

**Enforced in LIVE** (`src/box/executionGateway.ts`):
- admission gate at `:261` (`evaluateEntryCoherence`), immediately after the depth
  precheck and BEFORE the capital gate and any `manager.submit` — a rejection here is
  a zero-POST `REFUSED_BEFORE_SUBMIT` with no exposure;
- re-check at `:327` (`recheckEntryCoherence`), immediately before the four legs
  transmit, against CURRENT books (a book coherent at admission can be stale by the
  time leg 4 sends).

**Enforced in PAPER** (`src/box/executionSimulator.ts:718`): the legging skew gate now
calls the SAME `evaluateBookCoherence` with the paper policy, replacing the old
inline exchange-only check. The measured `temporal` figures are still surfaced on the
record.

## 3. Per-broker exchange-timestamp semantics and precision (verified 2026-09-09)

Recorded in code as `BROKER_TIMESTAMP_NOTES` and asserted by a test.

- **Zerodha — Kite Connect v3 WebSocket, `full` mode.**
  Source: https://kite.trade/docs/connect/v3/websocket/
  The `full` quote packet carries an **Exchange timestamp** (bytes 60-64, `int32`),
  which is **epoch SECONDS → ONE-SECOND (1000 ms) granularity**. `quote`/`ltp` modes
  carry NO exchange timestamp. A sub-second exchange-dispersion threshold is therefore
  unsatisfiable-by-quantisation for Kite and would reject coherent books on rounding
  alone.
- **Dhan — DhanHQ v2 live market feed.**
  Source: https://dhanhq.co/docs/v2/live-market-feed/
  Neither the Quote packet nor the Full packet (the one carrying 5-level depth) has a
  depth-publication timestamp. The only time field is **Last Trade Time (LTT)**, epoch
  seconds. LTT is when the instrument LAST TRADED, not when the depth was published. So
  **Dhan supplies NO usable order-book exchange timestamp**, and the policy MUST NOT
  substitute LTT for one — it falls back to receive-time for Dhan legs.

**Consequence for thresholds:** exchange-time dispersion is applied only when EVERY
leg carries a real book timestamp; otherwise the always-available receive-time
constraint governs. Thresholds are broker-aware and never sub-second for Kite.

## 4. What receive-time coherence does and does not prove (stated in code and status)

- **Does:** bound how far apart the four packets ARRIVED at our process — a
  necessary, self-controllable liveness/staleness bound we actually control.
- **Does NOT:** prove the exchange PUBLISHED the four books at the same instant. A
  burst of queued packets can arrive together yet describe books stamped seconds
  apart at the exchange; network jitter can spread genuinely simultaneous books. The
  reject detail says so verbatim ("proves arrival spread only, not exchange
  simultaneity"), and `CoherenceDecision.basis` reports whether admission rested on
  `exchange` or `receive` evidence.

## 5. Entry vs protective reduction (the ENTRY-ONLY discipline)

The coherence gate is ENTRY-ONLY, matching `src/box/liveEntryGuard.ts`'s scope rule.
`evaluateReductionCoherence` is the reduction-side path and deliberately checks ONLY
that the single leg being reduced has a current depthful book to price against — it
never looks at the other legs, at cross-leg dispersion, or at per-leg age as a
rejection. Blocking a risk-reducing order because the four books are not a tidy
snapshot would strand real naked exposure — strictly worse than the incoherence. Test:
"PROTECTIVE REDUCTION is NOT blocked when four-leg coherence has deteriorated."

## 6. Configurable, broker-aware thresholds and defaults (with rationale)

New `BoxConfig` keys (all in `config.ts`, exposed in the config snapshot, documented
in `.env.example`):

| Key (env) | Default | Rationale |
|---|---|---|
| `BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS` | 250 (unchanged) | Existing knob; applies only when every leg has a real book timestamp. Kept at 250 to avoid changing an asserted default; NOTE it is below Kite's 1 s precision, so in practice the receive-time gate is the effective live constraint until an operator raises this to ≥ 1000 ms for Kite-only runs. |
| `BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS` | 500 | The ALWAYS-available cross-sectional bound (Dhan has no book stamp; Kite's is coarse). 500 ms comfortably admits a genuine simultaneous snapshot over one socket yet rejects visibly out-of-step legs. This is the primary LIVE gate. |
| `BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS` | 5000 | A book cannot be received before it was published; 5 s tolerates coarse stamps and normal feed latency without flagging a fault. |
| `BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE` | false | See "meaning of 0" below. |
| `maxExchangeAheadOfReceiveMs` (no env yet; default 1500) | 1500 | Tolerates exchange stamps sitting slightly AHEAD of receive time due to Kite's 1 s rounding and host/exchange clock skew; beyond this it is a future-clock fault. Handoff item to add an env knob if tuning is needed. |

**Meaning of a `0` dispersion limit** (the `.env.example` value):
- **LIVE default (flag false):** `0` is **IMPOSSIBLE-TO-SATISFY** — it rejects every
  multi-leg admission. This is deliberate: an unconfigured operator can NEVER silently
  get "no cross-leg coherence enforcement" in live from a `0`.
- **LIVE with explicit opt-out (`...DISABLES_IN_LIVE=true`):** `0` DISABLES the
  receive-dispersion constraint (per-leg age and exchange checks still apply).
- **PAPER:** `0` always means "disabled", preserving historical paper behaviour and
  keeping research configs comparable.
Both readings are covered by tests.

## 7. Explicitly handled edge cases (all tested)

Missing timestamps (fall back to receive-time, never self-reject); missing book /
depthless update (fail closed); reconnect **generations** — a leg from a superseded
generation, and legs that SPAN two generations, are refused (built on the existing
`quotes.ts` `invalidateGeneration()` / `generation_invalidations` concept); clock
anomalies (negative/future age, and exchange-ahead beyond tolerance) refused, while a
small coarse-stamp ahead-skew is tolerated; duplicate packets / feed stall (re-check
refuses when no book advanced and all are at/over the age limit); per-leg age enforced
independently of dispersion.

## 8. Before/after evidence for the 8,000 ms case (verbatim)

Full verbatim capture — WITH and WITHOUT exchange timestamps, pre-fix ADMIT and
post-fix REJECT — is in `EVIDENCE-coherence.md`. Summary: pre-fix probe PASSES (live
gateway submits all 4 legs on an 8 s-dispersed book, both with and without exchange
stamps); post-fix the same probe FAILS with `0 !== 4` (nothing submitted). Kept
assertions in `tests/box/executionCoherence.test.mjs` prove the 8 s case is rejected
under a suitably configured LIVE policy in both cases and that a coherent book is
still admitted.

## 9. Test counts

- `tests/box/*` + `tests/invariants/*`: **1561 tests, 1561 pass, 0 fail, 0 skipped**.
- Full `npm test` (with `DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge`):
  **1839 tests, 1839 pass, 0 fail, 0 skipped, 0 todo** — the 1817 branch-point
  baseline plus 22 new coherence tests. No existing assertion was weakened, skipped or
  marked todo. The `shadowAndStress.test.mjs` assertion that the exchange-dispersion
  default is 250 remains true and unchanged.

## 10. HANDOFF items (files I do not own) — see HANDOFF-coherence.md

1. Feed parser must set `BoxTickInput.exchange_ts` from Kite full-mode bytes 60-64
   (epoch seconds × 1000); Dhan must NOT set it (LTT is not a book time).
2. Optional: stamp a real per-token socket generation on `BoxQuote` (the gateway
   currently uses `isTokenWarm` as a conservative generation proxy).
3. Optional: surface `CoherenceDecision.basis`/`reason` on the status endpoint.
4. Optional: add `BOX_MAX_EXCHANGE_AHEAD_OF_RECEIVE_MS` env knob (plumbing ready).

## 11. Remaining limitations

- The exchange-time constraint cannot engage in live until the Kite feed parser
  populates `exchange_ts` (Handoff #1). Until then the receive-time gate — the primary
  live constraint — is what fires. This is safe (fails toward the always-available
  bound), not a hole.
- Receive-time coherence remains a proxy for exchange simultaneity (§4); it is
  correctly labelled as such and never over-claimed.
- `maxExchangeAheadOfReceiveMs` and the generation proxy are conservative
  approximations pending the Handoff improvements; neither admits an incoherent book,
  they only trade some precision for safety.
