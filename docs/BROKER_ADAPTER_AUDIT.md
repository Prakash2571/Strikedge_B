# Broker adapter audit — Dhan and Zerodha

**Audit date: 2026-09-13.** Sources consulted are cited inline with the date they were read.

> **How to read this document.** Every row is marked with what kind of evidence backs it:
>
> | Mark | Meaning |
> |---|---|
> | **DOC** | Read from vendor documentation on the stated date. Verifies what the vendor *says*. |
> | **CODE** | Verified by reading this repository's source. Verifies what *we* do. |
> | **NOT VERIFIED** | Requires real credentials, deployed connectivity, or live broker observation. **Not established by this audit.** |
>
> A **DOC + CODE** row means the documented behaviour and our implementation were compared and
> agree. It does **not** mean the pair was observed working against a live account — that is
> always **NOT VERIFIED** here and belongs to Gate B.

## Environment limitation affecting this audit — read first

This audit was performed in a sandbox with **no direct internet egress**. Vendor documentation
pages could not be fetched in full (`HTTP 403`); only **search-result snippets** were retrievable.

Consequences, stated plainly:

- Figures already recorded in [`docs/BROKER_LIMITS.md`](./BROKER_LIMITS.md) (verified 2026-09-09,
  re-verified 2026-09-10 by fetching the official pages directly) are **carried forward**, and I
  cross-checked them against snippets where possible. Where a snippet **disagreed**, it is recorded
  below rather than quietly reconciled.
- Anything *new* in this document that rests only on a snippet is marked **DOC (snippet only)**,
  which is weaker evidence than the earlier full-page verification and should be re-checked from
  the vendor page before a live trial.
- No trading endpoint was contacted. No credential was used.

---

## 1. Regulatory constraints that changed, and that gate the deployment

These are the highest-consequence findings in this audit, because they can make a technically
correct deployment **fail at the exchange** or **breach a registration requirement**.

| # | Finding | Evidence | Impact on this system |
|---|---|---|---|
| 1.1 | **SEBI static-IP mandate is in force.** A dedicated static IP registered against the API key is required for retail algo order placement. One source states the mandate took effect **1 April 2026**. | **DOC (snippet only)** — [quotaguard.com/blog/dhan-api-static-ip](https://www.quotaguard.com/blog/dhan-api-static-ip) (third-party, read 2026-09-13); corroborated by Zerodha's own summary below | EC2 Mumbai must have a **stable Elastic IP**, registered with the broker. Already modelled for Dhan (`DHAN_STATIC_IP_EXPECTED` → `staticIpReady()`), which **blocks order placement** and reports it in `health()` when unconfirmed. **No equivalent gate exists for Zerodha** — see gap 5.1. |
| 1.2 | **Retail algos are capped at 10 orders/second per segment per exchange without exchange registration.** Above that threshold the strategy requires exchange registration. Individuals need a static IP dedicated to their API key. | **DOC (snippet only)** — [Zerodha Z-Connect, NSE retail algo framework](https://zerodha.com/z-connect/general/a-comprehensive-overview-of-nses-circular-on-the-new-retail-algo-trading-framework) (vendor blog, published 2025-05-06, read 2026-09-13) | A one-lot four-leg box sends **4 orders per attempt**. Well inside 10/s *per attempt*, but the pacing ledger must not allow bursts across concurrent attempts to cross it. Our configured order pacing (10/s Kite, 10/s Dhan — `BROKER_RATE_LIMITS`) already sits **at** this line, so the regulatory ceiling and the API ceiling coincide. **Registration status for this account: NOT VERIFIED.** |

> **Operational consequence.** Both items are **preconditions for the trial**, not implementation
> details. They are in the Gate B checklist in [`docs/TRIAL_RUNBOOK.md`](./TRIAL_RUNBOOK.md).

---

## 2. Rate limits

Carried forward from `docs/BROKER_LIMITS.md` (full-page verification 2026-09-09 / 2026-09-10) and
cross-checked against 2026-09-13 snippets.

| Limit | Zerodha (Kite Connect v3) | Dhan (DhanHQ v2) | Evidence |
|---|---|---|---|
| Order placement | 10/s, 400/min, 5,000/day per API key | 10/s, 250/min, 1,000/hr, 7,000/day | **DOC + CODE** — matches `BROKER_RATE_LIMITS` in `src/box/brokerPacing.ts` |
| Quote | 1/s | 1/s | **DOC + CODE** |
| Other endpoints | 10/s | 20/s (non-trading) | **DOC + CODE** |
| Modifications per order | 25 | 25 | **DOC + CODE** |
| Throttle response | `429`; **a rejected order still counts against the daily budget** | `429` | **DOC** |

### A snippet that disagreed, recorded rather than reconciled

A Dhan **support-portal** article states order placement is **25/second and 250/minute**
([dhan.freshdesk.com](https://dhan.freshdesk.com/support/solutions/articles/82000891156-how-many-maximum-orders-can-be-placed-using-dhan-api-), published 2024-02-06, read 2026-09-13).
The **official v2 API documentation table** says **10/second**, which is what
`docs/BROKER_LIMITS.md` recorded from the page itself and what our pacing uses.

**Resolution: we keep 10/s.** It is the stricter figure, it comes from the API reference rather
than a two-year-old support article, and being wrong in this direction only costs latency. The
disagreement is recorded because a future reader comparing sources will otherwise hit it and may
"correct" the code in the unsafe direction.

---

## 3. Order-status and partial-fill semantics — the brokers genuinely differ

This is where "do not assume the brokers behave identically" bites, and where normalization
correctly lives in the adapters.

| Concern | Zerodha | Dhan | Evidence |
|---|---|---|---|
| Terminal success label | `COMPLETE` | `TRADED` | **DOC + CODE** — `kiteState()` / `dhanOrderState()` |
| Explicit partial label | none; a partial presents as `OPEN` with a non-zero `filled_quantity` | `PART_TRADED` | **CODE** |
| **Contradictory label handling** | `COMPLETE` is trusted only against the quantity | **`TRADED` with a short fill is resolved as `PARTIALLY_FILLED`, never `COMPLETE`** | **CODE** — `dhanOrderState()` |
| Validity lapse | — | `EXPIRED`; with a partial fill the remainder is treated as **cancelled**, not rejected | **CODE** |
| Cancelled synonym | `CANCELLED` | `CANCELLED` **and** `CLOSED` | **CODE** |
| Unrecognised status | → `UNKNOWN`, never guessed | → `UNKNOWN`, never guessed | **CODE** |
| Quantity field on the order stream | `filled_quantity` (postback) | `TradedQty` (order alert) | **CODE** |
| **Missing quantity** | absent ⇒ `quantityPresent: false`; **never read as a confirmed zero** | same | **CODE** — both parsers |

**Why this matters for a box.** A `TRADED`/`COMPLETE` label with a short fill is the single most
dangerous status to mis-read: treating it as complete would mark a leg done while real residual
quantity is still working, and the four-leg exposure model would be wrong. Both adapters resolve the
label **against the accepted quantity** rather than trusting it.

---

## 4. Order-stream (WebSocket) semantics

| Concern | Zerodha | Dhan | Evidence |
|---|---|---|---|
| Transport | order postbacks arrive as **TEXT frames on the same socket** that carries binary ticks | **dedicated socket** `wss://api-order-update.dhan.co` | **DOC + CODE** |
| Authentication | credentials are in the **connection request**; the broker **refuses the handshake** when invalid, so an open socket *is* acceptance | login frame `{LoginReq:{MsgCode:42,…}}` sent after open; **no acknowledgement frame exists** | **DOC + CODE** |
| Authorisation evidence we claim | `broker_acknowledged` | **`login_submitted` — an assumption, upgraded to `rest_verified` only when a REST call on the same session succeeds** | **CODE** — `OrderStreamAuthEvidence` |
| Auth failure observability | handshake refusal | **only later, as a close with an auth code** (1008/4001/4401/4403) | **CODE** |
| Replay of events missed while disconnected | **not promised** | **not promised** | **DOC** |
| Per-event sequence number | none | none | **CODE** |

**Consequences already implemented.** Because neither broker promises replay, every connection —
first connect included — **owes a REST reconciliation** before new entry is permitted, and the
sweep's *result* is checked rather than merely awaited. Because neither supplies a sequence number,
event identity is `(orderId, timestamp, cumulativeQty, status)` and correctness rests on
**cumulative monotonicity**, not on ordering. Both brokers' timestamps are **1-second granular**,
which is why the status is part of the identity: without it, `OPEN(0)` and `CANCELLED(0)` stamped in
the same second collide and the cancellation is discarded as a redelivery.

---

## 5. Identified gaps and asymmetries

| # | Gap | Status |
|---|---|---|
| 5.1 | **No static-IP readiness gate for Zerodha.** Dhan has `staticIpReady()` blocking placement; Zerodha has no equivalent, yet finding 1.1/1.2 applies to **both**. | **OPEN — not fixed in this pass.** Documented as a Gate B precondition instead of adding an unverified gate. Fixing it properly needs the vendor's own readiness signal, which I cannot verify here. |
| 5.2 | **Zerodha splits large orders server-side** into up to 50 slices (e.g. 1,800 qty each for Nifty). One API call can therefore become **many exchange orders**. | **DOC (snippet only)** — [Z-Connect, order placement](https://zerodha.com/z-connect/featured/order-placement-simplified) (read 2026-09-13). **Not a risk for a one-lot trial** (a single lot is far below any freeze quantity), but it means order-count and rate-limit reasoning must not assume 1 call = 1 order at larger sizes. We introduce **no splitting of our own**. |
| 5.3 | **Dhan funds semantics unresolved.** Whether `availabelBalance` is already net of `utilizedAmount` could not be established from the API reference. | **NOT VERIFIED.** Handled conservatively in code (`BROKER_FUNDS_SEMANTICS.dhan = "unverified"` → understating reading, which refuses affordable entries rather than admitting unaffordable ones) and every refusal names the unverified semantics. Resolving it is a Gate B read-only check. |
| 5.4 | **Zerodha funds semantics rest on the support portal**, not a field-level API statement. | **DOC (weak) + NOT VERIFIED against a live account.** The screen-to-field identification (`available margin` → `available.live_balance`) is reasonable but **not vendor-confirmed**. |
| 5.5 | **Session/token expiry timing.** Dhan v2.4 (dated 2025-09-22) reduced access-token duration and introduced API-key-based authentication and IP setup, per the vendor release notes. The exact expiry window for this account is not established. | **DOC (snippet only)** + **NOT VERIFIED.** The system already treats an auth-code close as `AUTH_EXPIRED` (a distinct, terminal state that refuses everything but a cancel) rather than retrying a rejected credential. |

---

## 6. What this audit does **not** establish

Stated explicitly, because a table full of ticks invites the opposite conclusion:

- **No live broker call was made.** Every **DOC + CODE** row compares documentation to source. None
  observes the pair working against a real account.
- **Instrument identifiers, lot sizes and tick sizes were not verified against a live instrument
  dump.** The adapters read them from the brokers' own masters at runtime; that path is exercised in
  CI against **checked-in fixtures**, not against today's live master.
- **Order rejection families** are classified from codes and free text (`classifyDhanReject`). The
  mapping is **NOT VERIFIED** against real rejections.
- **Margin API response-field availability** is modelled from documentation. Whether *this account*
  receives `initial`/`final` on every basket call is **NOT VERIFIED**.
- **Registration status under the retail algo framework** (finding 1.2) is an account-level fact
  this audit cannot see.

## 7. Change log

| Date | Change |
|---|---|
| 2026-09-13 | Document created. Added regulatory findings 1.1/1.2, the rate-limit snippet disagreement in §2, the per-broker status/stream comparison in §3–4, and gaps 5.1–5.5. |
| 2026-09-10 | (In `BROKER_LIMITS.md`) Rate limits re-verified from official pages; no figure changed. |
| 2026-09-09 | (In `BROKER_LIMITS.md`) Rate limits first verified. |

*Content from vendor sources was paraphrased rather than quoted, for licensing compliance.*
