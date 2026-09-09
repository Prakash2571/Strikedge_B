# Broker rate limits — verified reference

**Verification date: 2026-09-09.** Every figure below was read from the cited OFFICIAL
source on this date. This file is the human-readable companion to `BROKER_RATE_LIMITS` in
`src/box/brokerPacing.ts`; the constants there must match this table exactly.

> Web access was used ONLY to read public official documentation. No trading endpoint was
> contacted.

## Why this document exists — a corrected defect

The prior code (`src/box/brokerPacing.ts` header and the Dhan pacing profile) asserted that
**"Dhan permits materially more than 10 order requests/second."** The current official DhanHQ
v2 documentation states Order APIs are limited to **10 requests/second**. The old claim was
wrong in the dangerous direction (it would have justified pacing faster than the broker
allows, earning a 429 on a real order) and has been removed.

## Zerodha / Kite Connect v3

Source: <https://kite.trade/docs/connect/v3/exceptions/#api-rate-limit>

| Endpoint class            | per second | per minute | per hour | per day | Notes |
|---------------------------|-----------:|-----------:|---------:|--------:|-------|
| Order placement           | 10         | 400        | —        | 5,000   | Day cap is per user/API key, across all segments & varieties |
| Order modification        | 10         | 400        | —        | 5,000   | **Max 25 modifications per order**, then cancel & re-place |
| Order cancellation        | 10         | 400        | —        | 5,000   | Shares the order bucket |
| All other endpoints       | 10         | —          | —        | —       | Per the docs, "all other endpoints" = 10 req/s |
| Quote                     | 1          | —          | —        | —       | Data read |
| Historical candle         | 3          | —          | —        | —       | Data read |

`429 Too many requests` is the throttle response. A rejected order request still counts
against the daily order-request budget.

## Dhan / DhanHQ v2

Source: <https://dhanhq.co/docs/v2/> (the "Rate Limit" table under Introduction)

| Endpoint class     | per second | per minute | per hour | per day | Notes |
|--------------------|-----------:|-----------:|---------:|--------:|-------|
| Order APIs         | 10         | 250        | 1,000    | 7,000   | Placement, modify, cancel share this budget |
| — modifications    | —          | —          | —        | —       | **Capped at 25 modifications per order** |
| Data APIs          | 5          | —          | —        | 100,000 | Per-minute/hour published as unlimited |
| Quote APIs         | 1          | Unlimited  | Unlimited| Unlimited | Data read |
| Non-Trading APIs   | 20         | Unlimited  | Unlimited| Unlimited | e.g. funds, profile |

## Figures that could NOT be confirmed (conservative choices made)

1. **Kite per-hour order cap.** Kite documents no explicit per-hour order cap. Modelled as
   *unlimited* per hour; the 400/min and 5,000/day caps govern. Conservative because the
   tighter minute/day windows still bind.
2. **Dhan orders/second — a source conflict.** A Dhan customer-support FAQ
   (`dhan.co/support/.../what-are-the-api-rate-limits-for-dhan/`) quotes **25 orders/second,
   250/minute**, which conflicts with the DhanHQ v2 developer docs' **10/second, 250/minute**.
   We use the **stricter developer-doc figure (10/s)**. Guessing upward is the only direction
   that earns a real 429 on a real order; when official sources disagree we take the
   conservative interpretation, as required.
3. **NSE algo per-trader order rate.** No exchange-level figure was independently confirmed on
   the verification date; the broker-published order caps above are used directly rather than a
   separate exchange cap.

## How the code uses these figures

`src/box/brokerPacing.ts`:

- `BROKER_PACING_PROFILES` — the per-second min-interval (Kite 110 ms default / 100 ms floor;
  Dhan 120 ms floor, which is *above* the 100 ms the 10/s limit alone allows and therefore
  conservative). This bounds only the per-second window.
- `BROKER_RATE_LIMITS` — the full per-window table above, frozen. Every widening is a
  reviewable diff against this constant.
- `placementBudgets()` — divides each window by `workerCount` (budgets are SHARED across this
  application's workers on the same account) and withholds a **recovery reserve** so protective
  cancels/exposure reduction always have room after placement traffic. The reserve default is
  20%, chosen so even the tightest window (10/s ⇒ 2 reserved slots; 400/min ⇒ 80) always covers
  a full four-leg protective unwind — the explicit economic bound for the reserve.
- `RateBudgetLedger` — accounts spend against all windows, honours `Retry-After` cooldowns
  (never shortening one), and **exposes no replay/resend path**: a 429 or transport error must
  never cause a mutation to be replayed, because it tells us nothing about whether the matching
  engine saw the order. `external_consumers_unobservable: true` in every snapshot documents
  that requests by unrelated apps on the same account are invisible and require operational
  coordination.
