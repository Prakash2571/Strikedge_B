# StrikeEdge runbook

Day-in-the-life operations for StrikeEdge. Read `docs/DEPLOYMENT.md` for install
and the cutover; this document is what you keep open during a trading day.

## The trading day at a glance

1. **~09:00 IST — token acquisition.** StrikeEdge's morning poll
   (`BROKER_TOKEN_POLL_START`, default `09:00`, retrying every
   `BROKER_TOKEN_POLL_INTERVAL_MS`) fetches the day's access token for the active
   broker from CalSpread's token route. Until a healthy token arrives, no trading
   is possible.
2. **09:15 IST — market opens.** With a token and a healthy feed, the scanner (if
   started) publishes opportunities. In paper mode it simulates; live requires all
   gates + arming.
3. **15:40 IST — trading window closes** (the market-hours predicate).
4. **Overnight** — the Mongo projector drains the outbox to Atlas for reporting.

## Reading `GET /api/runtime/status`

The single pane of glass. Check it first for anything. It reports, among others:

- **token state** for the active broker (see below);
- **PostgreSQL** readiness (`ready` / `connecting` / `failed`) and pool counts;
- **scanner** running or not;
- **exposure**: open positions, working orders, execution-in-flight, residual
  legs, unknown/ambiguous orders, unresolved order intents, reconciliation
  complete;
- **arming** state (armed / disarmed) and the effective execution mode.

"Flat and safe" = zero open positions, zero working orders, nothing in flight,
zero residual legs, zero unresolved intents, reconciliation complete.

## Reading `GET /api/export/status`

The Mongo projection health: whether export is enabled, whether Atlas is
connected, the outbox **backlog** (undrained rows), and dead-lettered rows. A
small, draining backlog is normal. A growing backlog means the projector is
behind — see "Mongo backlog grows" below. **This never affects trading**; it is
reporting only.

## Token states and what they mean

The token provider client classifies the CalSpread response:

- **healthy / authenticated** — a live token with a `login_date`; trading can
  proceed (subject to gates).
- **409 (no live session)** — the broker has **no live/unexpired session** at
  CalSpread right now. CalSpread has not completed (or has lost) that broker's
  login for the day. The route deliberately answers 409 rather than serving a
  dead token.
- **403 (forbidden)** — the passcode was rejected (wrong/rotated
  `KITE_TOKEN_BROKER_PASSCODE` / `DHAN_TOKEN_BROKER_PASSCODE`) or access is
  otherwise denied.
- **security_error** — the token came back but failed a safety check, e.g. its
  api_key/client_id did not match `KITE_API_KEY_EXPECTED` /
  `DHAN_CLIENT_ID_EXPECTED`, or the `login_date` is stale (not today's IST day).
  StrikeEdge refuses a token that fails these checks.

### Zerodha token stuck at 409

CalSpread has no live Zerodha session. **Action:** have the CalSpread operator
complete the Zerodha login for the day. StrikeEdge keeps polling
(`BROKER_TOKEN_POLL_INTERVAL_MS`) and picks the token up automatically once
CalSpread has it. Do **not** try to force a token in; there is nothing to force.

### Zerodha token stuck at 403

The passcode is wrong or was rotated. **Action:** verify
`KITE_TOKEN_BROKER_PASSCODE` matches what CalSpread expects; fix `.env` and
restart (or wait for the next poll if only the upstream changed). A 403 is a
credential problem, not a market problem.

### login_date is stale

The token belongs to a previous IST day. **Action:** this means CalSpread served
yesterday's session. It should refresh on CalSpread's side; StrikeEdge will
reject the stale token (security_error) rather than trade on it. Confirm the
CalSpread operator has done today's login. Never override the day check.

### Dhan expiry unknown

Dhan tokens carry an `expires_at`; if it is unknown/unparseable, treat the token
as **not trustworthy for live** — StrikeEdge will not go live on an ambiguous
expiry. **Action:** re-fetch (next poll), and if it stays unknown, have CalSpread
re-issue the Dhan session. Stay in paper on the Dhan side until expiry is known.

## Switching brokers safely

Exactly one broker is active. A switch is explicit and blocker-checked.

1. `GET /api/broker/status` — see the active broker and current blockers.
2. `GET /api/broker/switch-blockers?broker=<target>` — ask *why* a switch would be
   refused, **without attempting it**.
3. `POST /api/broker/select` (body names the target) — perform it.

**Reading a refused switch.** A refused switch returns **HTTP 409** with
`code: "switch_refused"` and the **full `blockers` array** — every reason at once.
Typical blockers: the scanner is running, there are open positions on a broker,
working orders, execution in flight, residual legs, unknown/ambiguous orders, or
unresolved order intents for a broker. **You cannot switch away from a broker that
still has live Box exposure or in-flight work** — that is the point. Clear the
listed blockers (stop scanner, let executions settle, reconcile/flatten
residuals) and retry. Never try to work around a blocker; it is protecting you
from running two brokers' state at once.

## When the Mongo backlog grows

Symptom: `GET /api/export/status` backlog climbing, Atlas connected=false or
erroring.

- **Trading is unaffected** — Atlas is a reporting replica, off the hot path.
- Check Atlas reachability and `MONGODB_URI`. The projector backs off up to
  `MONGO_EXPORT_MAX_BACKOFF_MS` and retries automatically.
- Once Atlas is healthy, the backlog drains on its own. If it does not, run
  `npm run outbox:replay` to re-drive from PostgreSQL.
- Dead-lettered rows (poison) are reported separately and need manual inspection;
  they do not block the rest of the drain.

## When PostgreSQL is unavailable

PostgreSQL is the operational authority, so this is serious — but the failure mode
is deliberately asymmetric:

- **New entries BLOCK.** A new Box entry requires a durable order intent written
  before the broker POST; if it cannot be written, the entry does not happen.
  This is fail-safe: better no new position than an unrecorded one.
- **Exits and protective operations MUST NOT block.** Managing and exiting boxes
  that are already open, and flattening residual legs, continue — the engine
  records the failure reason (`exit_blocked_reason`) but does not refuse to
  protect an open position on a DB hiccup.

**Action:** treat it as an incident. Check `GET /api/runtime/status` (PostgreSQL
state + last error) and `/api/health`. Restore PostgreSQL. On recovery, StrikeEdge
reconciles from the durable state. Do **not** restart repeatedly hoping it clears;
fix the database.

## Arming and disarming live trading

- **Arm:** `POST /api/box/session/arm` — the runtime switch that, on top of the
  deployment gates (`BOX_EXECUTION_MODE=live` + `BOX_LIVE_TRADING_ENABLED=true`)
  and the active broker's per-broker gate, actually permits live orders.
- **Disarm:** `POST /api/box/session/disarm` — always allowed, takes effect
  immediately. Disarming stops new live entries; it does not abandon open
  positions.
- The **site passcode arms nothing** — it only lets an operator into the UI.

## Emergency flatten

When you need to get out now:

1. **Disarm** — `POST /api/box/session/disarm` (stop new entries).
2. **Stop the scanner** — `POST /api/box/stop`.
3. **Cancel working orders** — `POST /api/box/live/cancel-working`.
4. **Flatten** — `POST /api/box/live/flatten` to close open legs/residuals at
   market. Flattening bills its own charges, exactly as the paper path models.
5. **Reconcile** — `POST /api/box/live/reconcile`, then confirm
   `GET /api/runtime/status` shows flat: no open positions, no working/ambiguous
   orders, no residual legs, no unresolved intents.

## What NOT to do

- **Do NOT run CalSpread Box live execution while StrikeEdge owns it.** Two live
  scanners on one broker account can double-enter and race; neither store can
  fence the other. Keep CalSpread's `BOX_LIVE_TRADING_ENABLED=false` and
  `DHAN_LIVE_TRADING_ENABLED=false`.
- **Do NOT set `exec_mode: "cluster"` in PM2.** The in-process reservation tier is
  authoritative for one process; multiple workers are safe only via the durable
  PostgreSQL tier and only as a deliberate, tested change.
- **Do NOT treat MongoDB Atlas as a backup.** Restore from a PostgreSQL `pg_dump`.
  Replay goes PostgreSQL → Mongo, never the reverse.
- **Do NOT migrate under a live/armed process.** Follow the safe migration
  procedure (`docs/DEPLOYMENT.md` §10): stop, disarm, verify flat, back up,
  migrate, verify, restart.
- **Do NOT force a token in, override the `login_date`/expiry checks, or disable
  the Dhan static-IP guard** to "get trading". Those checks are refusing an unsafe
  credential.
- **Do NOT work around a refused broker switch.** Clear the blockers.
- **Do NOT change `BROKER_TOKEN_ENCRYPTION_KEY`** casually — it makes existing
  sealed tokens unreadable. Use `npm run rotate:broker-token-key` for a planned
  rotation.
