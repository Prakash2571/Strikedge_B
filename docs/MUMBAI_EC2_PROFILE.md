# Conservative Mumbai EC2 profile (`ap-south-1`)

The deliberately over-cautious starting posture for StrikeEdge live box arbitrage on a
Mumbai EC2 host. It is designed so that the FIRST live session risks as little as
possible while producing the broker observations you actually need — not so that it
trades often.

Read `docs/DEPLOYMENT.md` for PostgreSQL install, migrations, PM2, nginx and the
CalSpread cutover; `docs/RUNBOOK.md` for the trading day; `docs/CONFIGURATION.md` for
every variable. This document is the *profile* and the Mumbai/EC2-specific concerns.

Every default cited here was read from `src/box/config.ts`, `src/pg/pool.ts` and
`src/box/executionSchedulingPolicy.ts` in this commit. Where a value below equals the
shipped default it is marked "(default)".

---

## 1. What this profile does and does not promise

**Mumbai hosting guarantees nothing.** Co-locating in `ap-south-1` reduces expected
network round-trip to Zerodha/Dhan endpoints relative to a distant region. It does not
guarantee any latency, any queue position, or any fill rate. The exchange matching
engine, the broker's own infrastructure and your queue position at a price are all
outside this application. Do not treat a low measured HTTP round trip as evidence that
a box will fill.

**A loss breaker is not a guaranteed maximum loss.** `BOX_LIVE_DAILY_LOSS_LIMIT` stops
NEW entries once realised losses cross the threshold. It cannot:

- cap loss on exposure you already hold (a partially filled box can move against you
  after the breaker trips),
- prevent slippage on the protective unwind that follows,
- act faster than the broker confirms fills, or
- bound a gap move.

Treat it as "stop digging", not "maximum loss". The real worst case is unbounded by
this control and must be sized by the position itself.

---

## 2. The example configuration

```bash
# ─── EXECUTION MODE: real trading DISABLED by default ────────────────────────
# Two independent switches must BOTH be set before any real order can be placed.
# BOX_EXECUTION_MODE=live is REJECTED AT BOOT unless BOX_LIVE_TRADING_ENABLED=true
# (src/box/config.ts:906-909), so a single stray variable cannot arm live trading.
BOX_EXECUTION_MODE=paper_latency        # (default) start here; flip to `live` only when armed
BOX_LIVE_TRADING_ENABLED=false          # (default) the deployment kill switch

# ─── SIZE: one lot, one box ──────────────────────────────────────────────────
BOX_LIVE_MAX_OPEN_BOXES=1               # (default)
BOX_LIVE_MAX_CONCURRENT_EXECUTIONS=1    # (default)
BOX_ONE_ACTIVE_BOX_PER_UNDERLYING=true  # NOT the default (false) — turn it ON
BOX_SESSION_MAX_COMPLETED_TRADES=1      # NOT the default (0 = unlimited) — explicitly arm
                                        # a one-completed-box session for early runs

# ─── ENTRY TRANSPORT CONCURRENCY ─────────────────────────────────────────────
# Keep at 1. The offline benchmark (bench/executionLatency.mjs) shows raising this to
# 2 or 4 does NOT materially reduce first-to-last submit, because the broker pacing
# floor plus the hedge-first wave dependency dominates. Concurrency 4 also does NOT
# make four-leg execution atomic. See §8.
BOX_LIVE_ENTRY_SUBMIT_CONCURRENCY=1     # (default; min 1, max 4)

# ─── CAPITAL: gross order notional, NOT margin ───────────────────────────────
# This cap measures GROSS OPTION-ORDER NOTIONAL. It is NOT broker margin, NOT peak
# capital while legging, and NOT maximum loss. See docs/ECONOMIC_ADMISSION.md.
# Default is 0 = DISABLED. Set a real number before going live.
BOX_LIVE_MAX_BOX_CAPITAL_RUPEES=500000

# ─── LOSS BREAKER (see §1: not a guaranteed maximum loss) ─────────────────────
BOX_LIVE_DAILY_LOSS_LIMIT=5000          # (default)

# ─── FRESHNESS AND FOUR-LEG COHERENCE ────────────────────────────────────────
BOX_QUOTE_MAX_AGE_MS=15000              # (default) per-leg book age ceiling
BOX_FEED_MAX_AGE_MS=5000                # (default) whole-universe feed liveness
BOX_UNDERLYING_MAX_AGE_MS=10000         # (default)
# Cross-leg coherence. RECEIVE-time dispersion is the always-available gate: Dhan
# publishes no order-book timestamp at all, and Kite's is 1-second granular.
BOX_MAX_CROSS_LEG_RECEIVE_DISPERSION_MS=500    # (default)
# EXCHANGE-time dispersion applies only when EVERY leg carries a real book timestamp.
# NOTE the precision trap: Kite's exchange timestamp is whole SECONDS, so a value
# below ~1000 can reject coherent books on quantisation alone. 250 is the shipped
# default and is BELOW Kite precision — for a Zerodha-only run either raise it to
# >=1000 or accept that the receive-time gate is the effective constraint.
BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS=1000
BOX_MAX_RECEIVE_TO_EXCHANGE_DELAY_MS=5000      # (default)
# In LIVE, a 0 dispersion limit is IMPOSSIBLE-TO-SATISFY, not a silent bypass. Leave
# this false so an unconfigured operator can never accidentally lose the gate.
BOX_COHERENCE_ZERO_DISPERSION_DISABLES_IN_LIVE=false   # (default)

# ─── ORDER-UPDATE STREAMS: off, and currently NOT WIRED ──────────────────────
# These gates exist, but no running component consumes the order-update stream in
# this build, so fills are observed by REST polling only. `/api/box/status`
# .order_stream reports `not_wired` / `rest_polling_only` — believe it over the code's
# apparent capability. Do not set these expecting a fast fill path.
ZERODHA_ORDER_STREAM_ENABLED=false      # (default)
DHAN_ORDER_STREAM_ENABLED=false         # (default)

# ─── POSTGRESQL: authoritative operational state, same host ──────────────────
DATABASE_URL=postgres:///strikedge      # Unix socket on the same EC2 host
PG_POOL_MAX=10                          # (default)
PG_STATEMENT_TIMEOUT_MS=5000            # (default)
PG_LOCK_TIMEOUT_MS=2000                 # (default)
PG_MIGRATE_ON_BOOT=true                 # (default)
PG_APPLICATION_NAME=strikedge           # (default)

# ─── MongoDB Atlas: ASYNCHRONOUS projection only ─────────────────────────────
# Reporting/history only. The order path never awaits an Atlas acknowledgment.
MONGODB_URI=mongodb+srv://…
```

### Entry authorization is separate from exposure-management permission

Two independent controls, and the distinction is the point:

| Control | Governs | Set to |
|---|---|---|
| `entryEnabled` | May a NEW box be entered? | Off outside a supervised window |
| `liveOrderEnabled` | May we act on exposure we ALREADY hold? | **On** whenever exposure can exist |

`src/box/orderManager.ts:768` requires BOTH for entry, while `:787` requires only
`liveOrderEnabled` for protective work. So you can disarm new entries and still cancel
working orders and reduce owned exposure. **Never disable `liveOrderEnabled` while any
exposure or unresolved order exists** — that strands risk you can no longer manage.

### Automatic suspension of new entries

New entries are refused automatically (not merely warned) on: unresolved/unknown
orders, unproven reservation ownership, unsafe residual exposure, failed
reconciliation, and an open circuit breaker. The gate is `evaluateLiveEntryGuard`
(`src/box/liveEntryGuard.ts`), which is ENTRY-ONLY by design — it can never block
protective reduction. `/api/box/status` exposes `recovery_active`, `unknown_orders`,
`reconciliation_complete`, `residual_exposure_count` and `circuit_state`; the frontend
renders these as readiness blockers.

---

## 3. Stable outbound IP and broker static-IP requirements

Broker API access is commonly bound to a whitelisted static egress IP, and a default
EC2 public IP is **not** stable across stop/start.

- Attach an **Elastic IP** to the instance, or place it behind a **NAT Gateway** with
  an EIP and route all outbound broker traffic through it. Either way, outbound broker
  traffic must present ONE address you have registered with the broker.
- If you use an Auto Scaling group or ever replace the instance, the EIP/NAT must
  follow, or API calls will start failing authentication after the swap.
- Register the same address with **both** brokers if you run both.
- Re-verify the egress address after any instance resize, AMI change or network
  reconfiguration: `curl -s https://checkip.amazonaws.com`.
- Broker IP-whitelisting rules change; confirm the current requirement in the broker's
  own console rather than assuming this document is current.

---

## 4. Clock synchronization

Coherence checks, deadlines and audit ordering all depend on the host clock.

- Use **Amazon Time Sync Service** (link-local `169.254.169.123`) via `chrony`.
- Verify: `chronyc tracking` — system time offset should be well under 50 ms.
- The coherence policy tolerates a bounded exchange-ahead skew (default 1500 ms)
  precisely because exchange stamps are coarse and clocks differ; that tolerance is
  not licence to run an unsynchronised clock. A large offset will surface as
  `clock_anomaly` refusals and will corrupt every measured span.
- Monotonic time is used for elapsed durations and deadlines, so a clock STEP cannot
  extend a deadline — but wall-clock stamps in the audit trail will still be wrong.

---

## 5. PostgreSQL durability and pool settings

PostgreSQL on the same host is the operational authority.

- **Do not** set `synchronous_commit = off`. `src/pg/pool.ts:14-18` documents that
  order-intent transitions must be durable before transport; turning it off voids the
  crash-safety argument that lets a restart recover exposure.
- `fsync = on`, `full_page_writes = on`. Use an **EBS gp3** volume; do not put the
  data directory on instance store.
- `PG_POOL_MAX=10` against a single-process app is generous. Watch
  `pg_stat_activity` for saturation rather than raising it blindly — pool exhaustion
  shows up as latency on the order path, where it matters most.
- `PG_STATEMENT_TIMEOUT_MS` and `PG_LOCK_TIMEOUT_MS` are applied per connection, plus
  `idle_in_transaction_session_timeout`. A wedged statement must not stall execution.
- Take a base backup plus WAL archiving before the first live session. See
  `docs/DEPLOYMENT.md` for backup/restore.

---

## 6. Monitoring

Watch these, and alert on them:

| Signal | Why | Where |
|---|---|---|
| Event-loop lag | A blocked loop delays the send guard, deadlines and cancels | `EventLoopLagMonitor` in `src/box/metrics.ts`; exposed in status `metrics` |
| CPU steal / credit | A burstable instance that exhausts credits stalls unpredictably | CloudWatch `CPUCreditBalance`, `CPUSurplusCreditBalance` — prefer a non-burstable instance type |
| Memory / RSS | GC pauses show up as latency outliers | CloudWatch agent |
| DB contention | Lock waits on the order path | `pg_stat_activity`, `pg_locks`, lock-timeout errors in logs |
| Feed age | `feed_age_ms`, `book_observation_age_ms` | `/api/box/status` |
| Order-stream wiring | Whether fills are stream- or REST-observed | `/api/box/status` `.order_stream.brokers[].fills_observed_by` |
| Unresolved exposure | Entry auto-suspension cause | `residual_exposure_count`, `unknown_orders`, `recovery_active` |
| Timing spans | Queue wait, pacing, persistence, network | status `metrics`; see §8 for what each excludes |

Do not alert on "market data healthy" as a proxy for fill observation — they are
different signals and the status payload says so explicitly.

---

## 7. Process restart and recovery behaviour

- Durable intent is written to PostgreSQL **before** any transport call, so a crash
  between persist and POST leaves a recoverable record rather than an invisible order.
- On boot, reconciliation runs before entry is admissible. `PG_MIGRATE_ON_BOOT=true`
  applies migrations; with `false` the process refuses to boot on a stale schema
  rather than running against it.
- New entries stay suspended while reconciliation is incomplete or unresolved orders
  exist. Exposure management remains permitted (see §2).
- Under PM2, use a restart policy that does not thrash: a crash loop that restarts
  mid-recovery repeatedly is worse than staying down. Prefer `--max-restarts` with a
  backoff and alert on restart count.
- **After any unclean shutdown with open exposure, reconcile manually before
  re-arming entry.** Automatic reconciliation is designed to be correct, not to be
  trusted blindly on its first live outing.

---

## 8. Configuration precedence and effective runtime values

Precedence, lowest to highest:

1. Code defaults (`src/config.ts`, `src/box/config.ts`, `src/pg/pool.ts`).
2. Process environment (`.env` loaded by the process manager, or PM2 `env`).
3. Runtime operator controls via the API (entry arming, execution control) — these
   override configured *permission* for the session but never widen a configured
   numeric limit.

Configuration is validated at boot and **fails closed** with the full list of
problems. Invalid numeric values fall back to the documented default rather than being
silently coerced to zero, and out-of-range values are clamped — so an effective value
can legitimately differ from what you typed.

**Always read the effective values back rather than trusting the file.**
`/api/box/status` `.config` publishes the parsed configuration actually in force,
including `max_cross_leg_exchange_dispersion_ms`,
`max_cross_leg_receive_dispersion_ms`, `coherence_zero_dispersion_disables_in_live`,
the pacing intervals with their `broker_order_interval_source` provenance, and the
capital cap with its metric label. If the status disagrees with your `.env`, the
status is what is running.

### What the timing metrics do and do not include

- Network duration (`post_to_http_response_ms`) starts at the final synchronous send
  boundary, so it **excludes** Dhan's lower local pacing queue. Local queueing appears
  as `scheduler_wait_ms` and pacing as `transport_wait_ms`; durable persistence is its
  own `persistence_wait_ms` rather than being hidden inside pacing.
- All spans are LOCAL observation times. Broker and exchange timestamps are reported
  separately where available; exchange arrival and exact exchange fill instants are
  **not** invented.

### Offline benchmark, and why concurrency stays at 1

`node bench/executionLatency.mjs` simulates the four-leg entry on a virtual clock
against the REAL pacer and real per-broker pacing profiles, with assumed response
delays. Result (500 iterations/cell, **simulated — not a live measurement**):

| Broker | Concurrency | first→last submit p50/p95 (ms) | four-leg completion p50/p95 (ms) |
|---|---|---|---|
| Zerodha | 1 | 446 / 1447 | 596 / 1737 |
| Zerodha | 2 | 440 / 1341 | 589 / 1646 |
| Zerodha | 4 | 440 / 1400 | 594 / 1643 |
| Dhan | 1 | 480 / 1459 | 621 / 1767 |
| Dhan | 2 | 480 / 1351 | 613 / 1666 |
| Dhan | 4 | 464 / 1427 | 619 / 1672 |

Concurrency barely moves the result because the four-leg pacing floor (330 ms Zerodha,
360 ms Dhan) plus the hedge-first dependency — dependent SELLs cannot transmit until
both BUY hedges are confirmed — is the binding constraint. So concurrency 1 is
recommended: no slower in the regime that matters, and simpler to reason about.
The response-delay distribution is an **assumption**, so these figures bound our own
code's behaviour, not the broker's.

---

## 9. CalSpread must be disabled first

**Requirement:** CalSpread Box execution MUST be disabled before activating StrikeEdge
live execution against a shared broker account.

Both systems place orders through the same broker credentials. If both run:

- Order-rate budgets are shared and neither application can see the other's requests,
  so both will believe they are within limits while the account is throttled.
- Reservations and "one active box" guarantees are per-application, so two systems can
  each believe they hold the only active box.
- Reconciliation may adopt or cancel orders it did not create.

StrikeEdge cannot detect requests made by another application on the same account.
This requires **operational coordination**, not a code guarantee. See the cutover
procedure in `docs/DEPLOYMENT.md`.

---

## 10. Migration, deployment and rollback

```bash
# 1. Back up FIRST (schema + data). See docs/DEPLOYMENT.md for pg_basebackup/WAL.
pg_dump --format=custom --file=/backup/strikedge-$(date +%F-%H%M).dump strikedge

# 2. Fetch and verify the release WITHOUT switching to it.
git fetch origin && git log --oneline origin/main -5

# 3. Clean install and build. A type error emits NOTHING (noEmitOnError), so a
#    successful build is meaningful evidence.
npm ci && npm run build

# 4. Run the full suite against a REAL PostgreSQL (mock DB tests do not count).
DATABASE_URL=postgres://strikedge:strikedge@127.0.0.1:55432/strikedge npm test

# 5. Apply migrations. With PG_MIGRATE_ON_BOOT=false, apply explicitly and assert.
npm run migrate

# 6. Start in PAPER first. Confirm /api/box/status .config shows the effective values
#    you intended and .order_stream reports what you expect.
pm2 restart strikedge --update-env

# 7. Only then, in a supervised window, arm live (see §2) and watch a single box.
```

### Rollback

```bash
# a. Disarm entry FIRST — but leave exposure management ON so you can still act.
#    Use the execution-control API; do NOT just kill the process while exposed.

# b. Confirm flat: no open boxes, no residual legs, no unknown orders.
curl -s localhost:PORT/api/box/status | jq '{open_positions, residual_exposure_count, unknown_orders, recovery_active}'

# c. Only when flat, roll the code back.
git checkout <previous-sha> && npm ci && npm run build && pm2 restart strikedge --update-env

# d. If the release included a migration, restore from the §10 backup rather than
#    hand-reverting schema. Contract version is pinned in contract/version.json; a
#    backend rollback that lowers contract_version REQUIRES a matching frontend
#    rollback, or the SPA will validate against a contract the backend no longer emits.
```

**Never roll back while exposure exists.** A rollback that changes recovery logic
underneath live exposure is how a recoverable partial becomes an unrecoverable one.

---

## 11. Required supervised live validation

Nothing in this repository can prove a future trade will fill. Before trusting this
profile, obtain real broker observations for at least:

1. A full four-leg entry that completes, with measured spans per leg.
2. A partial entry that triggers protective unwind, and its realised cost.
3. A no-fill cancellation, confirming cancel-to-terminal timing.
4. A deliberate rate-limit encounter, confirming no mutation is ever replayed.
5. A process restart with open exposure, confirming reconciliation recovers it.
6. Confirmation of whether the order-update stream is worth wiring, measured against
   the REST polling baseline this build actually uses.

Until those exist, every latency figure in this document is simulated and every fill
expectation is unproven.
