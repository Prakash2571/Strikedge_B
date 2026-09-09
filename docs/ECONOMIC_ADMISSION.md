# Honest economic and capital admission

This document explains the five DISTINCT economic quantities the Box admission path reasons
about, exactly what each can and cannot prove, and the provenance / freshness / failure
semantics enforced in `src/box/boxCapital.ts`.

The governing rule: **these five quantities are never conflated or substituted for one
another.** Each is measured or estimated independently and carries its own provenance.

## The five quantities

| # | Quantity | Type / provenance | What it PROVES | What it does NOT prove |
|---|----------|-------------------|----------------|------------------------|
| 1 | **Available broker funds** | `EconomicFigure`, `broker_confirmed` when fresh | What the account can deploy right now | Nothing about the box itself |
| 2 | **Margin required by the planned execution sequence** | `EconomicFigure`, `broker_confirmed` when fresh (Kite basket / Dhan multi) | The broker's *estimate* of the four-leg basket requirement | That the broker will ACCEPT the orders; it is an estimate, not a guarantee |
| 3 | **Peak temporary exposure (legging window)** | `EconomicFigure`, `estimate` | An upper bound on capital tied up before all legs + hedge benefit exist | The exact peak — that depends on fill order, which this pure module does not observe |
| 4 | **Gross order notional** | `EconomicFigure`, `estimate` (the existing metric, unchanged label) | The largest ₹ the four immutable LIMIT orders can transact | Broker margin, peak capital, or maximum loss |
| 5 | **Bounded worst-case entry cost** | `EconomicFigure`, `estimate` | The largest the LIMIT orders can cost (gross), the settled net debit, and estimated charges | That fills occur at these prices — they are worst-case bounds |

### On #4 (gross notional) — label preserved

`grossEntryOrderNotional()` and its label are unchanged. Its header already warns it
OVER-states a hedged box and must never be called "margin". This remains the deterministic,
offline, conservative admission gate. `evaluateBoxCapitalAdmission()` is untouched; the new
`evaluateEconomicAdmission()` keeps the gross-cap semantics in step with it.

## Provenance and freshness semantics

`EconomicProvenance` is one of:

- `broker_confirmed` — returned by a supported broker facility THIS session, within the
  freshness bound. The only provenance that satisfies `requireMarginEvidence`.
- `estimate` — computed by us from the bounded requests. Deterministic, but NOT a promise the
  broker will accept the orders.
- `stale` — a figure was obtained but is older than the configured freshness bound. **Treated
  as unusable for admission** (`usable === false`) while its value is retained for display.
- `unavailable` — no figure obtained. `value_rupees` is `null`, never `0`.

`brokerFigure()` applies the freshness bound: a value older than `maxAgeMs` is downgraded to
`stale`. `estimateFigure()` tags locally computed values and always states they are not
broker-confirmed. The distinction is enforced in the **types** (`value_rupees: number | null`
forces callers to branch on provenance before trusting a number).

## Failure behaviour (fail closed)

`evaluateEconomicAdmission()` enforces three INDEPENDENT controls, each failing closed:

- **Gross cap** (`grossCapRupees > 0`): refuse if gross notional exceeds it or is incomplete.
- **Margin evidence** (`requireMarginEvidence`): refuse unless #2 is `broker_confirmed` AND
  fresh. A stale or missing margin fetch produces `margin_evidence_stale_or_missing` — an
  explicit refusal, never optimistic admission.
- **Funds cover** (`requireFundsCover`): refuse unless #1 is usable and covers the strongest
  provable requirement — broker margin (#2) when usable, else the conservative worst-case
  entry cost (#5). **Never** the smaller net debit alone, and never on an unknown funds figure.

Multiple failing controls are reported together so an operator sees every problem at once.

## Before exposure vs. once partially exposed

- **Before any leg is sent**, the bounded four-leg plan must satisfy the configured controls
  above. This is a pre-trade check on immutable, one-lot LIMIT requests.
- **Once partially exposed**, `decidePartialRecovery()` applies an explicit recovery policy
  instead of chasing the original profit threshold:
  - margin/funds evidence not usable → `hold_and_reassess` (do not act on a stale number);
  - completion affordable & priceable → `complete_remaining_legs` (a hedge is safer than a
    naked partial);
  - completion not provable → `unwind_filled_legs` (shed the unhedged exposure).
  Every branch sets `one_lot_preserved: true` — the policy never resizes a partially filled
  box into an unsupported strategy.

## What the system fundamentally cannot prove

- It cannot guarantee broker acceptance from a margin ESTIMATE (#2) — only the broker's own
  acceptance at order time is authoritative.
- It cannot observe the exact peak legging exposure (#3) without the execution sequence owner
  (`orderManager`), so #3 is a conservative upper bound.
- Basket-margin support is used only where the broker actually provides it (Kite basket / Dhan
  `POST /margincalculator/multi`); no basket-margin facility is invented.

## Wiring status

These functions are ADDITIVE and pure. Wiring them into the live entry path (populating funds
and margin from the broker context, choosing freshness bounds, and consulting
`decidePartialRecovery` from the execution owner) requires changes in files owned by other
agents — see `HANDOFF-pacing-econ.md`.
