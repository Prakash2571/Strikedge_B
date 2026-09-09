# HANDOFF — coherence work (changes needed in files I do NOT own)

I own only the coherence policy module, the execution gateway/policy/simulator,
`config.ts`, `types.ts`, `quotes.ts`, `.env.example`, and `tests/box/*`. The items
below live in files owned by other agents and are required for the LIVE coherence
gate to have real exchange-timestamp evidence to work with. None of them is a
correctness hole in my module (it fails closed / falls back to receive-time when
the evidence is absent); they are what would let the exchange-time constraint
actually fire in production.

## 1. ~~Feed parser must populate `BoxTickInput.exchange_ts`~~ — **CLOSED 2026-09-09**

> **RESOLVED by the order-update-stream work, verified on the merged tree.**
> `src/ticker.ts:205-214` now reads the Kite exchange timestamp at packet offset 60 as a Unix
> **second**, multiplies by 1000 to ms, applies it only to full packets (`len >= 184`), and
> treats 0 as absent. That is exactly what this item asked for, so the exchange-dispersion
> half of the coherence gate is now **ACTIVE for Zerodha** rather than inert. Dhan correctly
> still sets no `exchange_ts` (it publishes only LTT, which is not a book time), so Dhan legs
> remain governed by the receive-time constraint. No action remains.

### Original item (kept for the record)


The quote store already carries `exchange_at` and only sets it when a tick supplies
a finite positive `exchange_ts` (`quotes.ts` `applyTicks`). The coherence policy
uses exchange-time dispersion ONLY when every leg has one, else it falls back to
receive-time. For the exchange constraint to engage in live:

- **Zerodha (Kite v3, full mode):** parse the "Exchange timestamp" at bytes 60-64
  of the quote packet. It is epoch **seconds** — multiply by 1000 to epoch ms
  before setting `exchange_ts`. Do NOT use "Last traded timestamp" (bytes 44-48).
  Source: https://kite.trade/docs/connect/v3/websocket/ (verified 2026-09-09).
- **Dhan (v2 live feed):** DO NOT set `exchange_ts`. The Full/Quote packets carry
  only Last Trade Time (LTT), which is a last-trade time, not a depth-publication
  time. Leaving `exchange_ts` unset is correct: Dhan legs are governed by the
  always-available receive-time constraint.
  Source: https://dhanhq.co/docs/v2/live-market-feed/ (verified 2026-09-09).

Until the Kite parser sets `exchange_ts`, live Kite runs enforce the receive-time
constraint only (which is the primary gate anyway; exchange-time is additive).

## 2. Per-leg socket generation for the gateway — `src/hub.ts` / wiring in `src/index.ts`

The gateway currently derives each leg's "current generation" from
`isTokenWarm(token)` (warm ⇒ in the current generation, cold ⇒ none). That is a
conservative proxy: it fails a cold token closed and catches a store-wide
`invalidateGeneration()` (which clears the map, making tokens cold). A stronger
signal would be a real per-token generation stamped on each `BoxQuote` at ingest,
so a leg that survived a partial reconnect could be distinguished from one that did
not. If you decide to stamp generation on the quote, expose it via the store and I
will read it directly instead of via the warm proxy. No behaviour is wrong today;
this is a precision improvement.

## 3. Optional: surface the coherence decision on the status endpoint — status owner

`BoxTemporalCoherence` is already attached to the legging record (`temporal`) on a
coherence refusal, and `CoherenceDecision.basis` states plainly whether admission
rested on exchange-time or receive-time evidence. If the status/diagnostics owner
wants the operator to see "why was entry refused / on what basis was it admitted",
plumb `admission.basis` and `reason` through — the data is already computed.

## 4. `maxExchangeAheadOfReceiveMs` has no env knob yet

`executionCoherence.ts` accepts `maxExchangeAheadOfReceiveMs` (default 1,500 ms,
covering Kite's 1 s stamp granularity plus host/exchange clock skew) but I did not
add a `BOX_*` env var for it because it is not part of the confirmed defect and the
default is well-justified. If operators need to tune it, add
`BOX_MAX_EXCHANGE_AHEAD_OF_RECEIVE_MS` in `config.ts` and pass it through
`livePolicyFromConfig` — the plumbing point is ready.
