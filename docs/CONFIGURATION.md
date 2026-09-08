# StrikeEdge configuration

Every variable StrikeEdge reads, grouped by concern. Defaults are the code
fallbacks (from `src/config.ts`, `src/box/config.ts`, `src/pg/pool.ts`,
`src/outbox/mongo.ts`, `src/brokers/*`). Configuration is validated at boot and
**fails closed** with the full list of problems.

Legend: **Req?** = required. "yes" means the process cannot function without it;
"prod" means required in production only; "no" means it has a safe default.

## Application (`src/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `PORT` | `3001` | no | TCP port to listen on. | Non-1..65535 fails boot. |
| `NODE_ENV` | `development` | no | `development` \| `test` \| `production`. | Unknown value is treated as `development`. |
| `APP_TIMEZONE` | `Asia/Kolkata` | no | Trading-day / token / P&L timezone. | Any value other than `Asia/Kolkata` fails boot — every day boundary is IST. |
| `FRONTEND_URL` | — | yes | Exact CORS origin (with credentials) and redirect target. | Missing/relative fails boot. Non-https in production fails boot (cookie is Secure). |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | no | Max graceful-shutdown time (ms). | `< 1000` fails boot. Must sit below PM2 `kill_timeout`. |

## Site access (`src/config.ts`, `src/access/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `SITE_ACCESS_SECRET` | — | yes | The site passcode, hashed into a session. **Arms nothing** — UI access only. | Unset ⇒ nobody can pass the access gate. |
| `SITE_SESSION_TTL_HOURS` | `24` | no | Session lifetime (hours). | Outside `0 < h <= 720` fails boot. |
| `SESSION_COOKIE_NAME` | `strikedge_session` | no | HttpOnly session cookie name. | Illegal chars fail boot. |
| `CSRF_ALLOWED_ORIGIN` | `FRONTEND_URL` | no | Origin required on mutating requests. | Non-absolute origin fails boot. |

## PostgreSQL (`src/pg/pool.ts`, `src/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | — | yes | libpq URL. Unix socket (`postgres:///strikedge`) or TCP. | Unset ⇒ boot throws `PgUnavailableError`; PostgreSQL is not optional. |
| `PG_POOL_MAX` | `10` | no | Max pooled connections. | Non-positive ⇒ default. |
| `PG_STATEMENT_TIMEOUT_MS` | `5000` | no | Per-statement timeout applied on connect. | Too low ⇒ legitimate statements abort; too high ⇒ a wedged statement can stall the execution path. |
| `PG_LOCK_TIMEOUT_MS` | `2000` | no | Lock-acquisition timeout. | Too high ⇒ contention stalls. |
| `PG_MIGRATE_ON_BOOT` | `true` | no | Apply migrations at boot vs assert-only. | `false` ⇒ boot refuses if schema is behind (run `npm run migrate`). |
| `PG_APPLICATION_NAME` | `strikedge` | no | `application_name` in `pg_stat_activity`. | Cosmetic. |

## Token encryption (`src/brokerState/tokenCrypto.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BROKER_TOKEN_ENCRYPTION_KEY` | — | yes | AES-256-GCM key for tokens at rest. **Exactly 32 bytes**, as 64-char hex OR base64/base64url decoding to 32 bytes. | Wrong length/encoding ⇒ typed error. Changing it ⇒ old sealed tokens unreadable (re-acquired next morning). |

## Zerodha token provider (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `KITE_TOKEN_BROKER_URL` | `https://calspread.online/api/kite/token` | no | CalSpread's Zerodha token endpoint. | Wrong URL ⇒ token fetch fails; no Zerodha trading. |
| `KITE_TOKEN_BROKER_PASSCODE` | — | yes (Zerodha) | Shared passcode for CalSpread token routes. | Unset/wrong ⇒ token fetch rejected. |
| `KITE_API_KEY_EXPECTED` | — | prod | If set, fetched token's api_key must equal this. | Mismatch ⇒ token rejected as foreign (a safety feature). |

## Dhan token provider (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DHAN_TOKEN_URL` | `https://calspread.online/api/dhan/token` | no | CalSpread's Dhan token endpoint. | Wrong URL ⇒ no Dhan trading. |
| `DHAN_TOKEN_BROKER_PASSCODE` | — | yes (Dhan) | Shared passcode for the Dhan token route. | Unset/wrong ⇒ token fetch rejected. |
| `DHAN_CLIENT_ID_EXPECTED` | — | prod | If set, fetched token's client_id must equal this. | Mismatch ⇒ token rejected. |

## Token scheduling (`src/tokens/*`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BROKER_TOKEN_POLL_START` | `09:00` | no | IST HH:MM the morning poll starts. | Bad format ⇒ falls back to default. |
| `BROKER_TOKEN_POLL_INTERVAL_MS` | `60000` | no | Re-poll interval until a token is obtained. | Too small ⇒ hammers CalSpread. |
| `BROKER_TOKEN_REQUEST_TIMEOUT_MS` | `10000` | no | Per-request token-fetch timeout. | Too low ⇒ spurious failures on a slow morning. |

## Broker selection (`src/brokers/registry.ts`, `src/brokerRoutes.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DEFAULT_ACTIVE_BROKER` | `zerodha` | no | Which broker is active at boot. | Unknown ⇒ defaults to zerodha. |
| `AUTO_FALLBACK_TO_DHAN` | `false` | no | Allow automatic fallback to Dhan. | `true` in production is discouraged; a switch should be explicit. |

## Shared Box live gates — GATE 1 (`src/box/config.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_EXECUTION_MODE` | `paper_latency` | no | `paper_latency` \| `paper_legging` \| `live_parity` \| `live`. | `live` **requires** `BOX_LIVE_TRADING_ENABLED=true` or the loader refuses to start. |
| `BOX_LIVE_TRADING_ENABLED` | `false` | no | Shared live master switch. | Strict boolean: a typo is read as `false` (fail-safe). |

## Broker-specific live gates — GATE 2 (`src/brokers/registry.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `ZERODHA_LIVE_TRADING_ENABLED` | `false` | no | Per-broker gate for Zerodha. | Must be `true` when Zerodha is active and going live. |
| `DHAN_LIVE_TRADING_ENABLED` | `false` | no | Per-broker gate for Dhan. | Must be `true` when Dhan is active and going live. |

## Dhan safety & charge card (`src/brokers/dhan/http.ts`, `src/brokers/registry.ts`, `src/brokers/dhan/charges.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `DHAN_STATIC_PUBLIC_IP` | — | Dhan-live | The whitelisted egress IP presented to Dhan. | Empty while `DHAN_STATIC_IP_EXPECTED=true` ⇒ live blocked. |
| `DHAN_STATIC_IP_EXPECTED` | `true` | no | Require observed egress IP to match. | `false` disables the guard — do not, in production. |
| `DHAN_DATA_ENABLED` | `false` | no | Enable the Dhan market-data API. | `false` while Dhan is active ⇒ no Dhan feed. |
| `DHAN_CLIENT_ID` | (from token session) | no | Dhan client id (non-secret). | Wrong ⇒ order calls fail. |
| `DHAN_HTTP_TIMEOUT_MS` | `8000` | no | Per-HTTP-call timeout (range 500..60000). | Too low ⇒ spurious timeouts. |
| `DHAN_MIN_INTERVAL_MS` | `120` | no | Broker-side HTTP pacing floor (range 0..5000). | A smaller Box-level value cannot beat this. |
| `DHAN_MAX_READ_ATTEMPTS` | `3` | no | Order-status read attempts (range 1..6). | Too low ⇒ premature "unknown" on a slow read. |
| `DHAN_BROKERAGE_PER_ORDER` | `20` | no | Dhan F&O brokerage per order (₹). | Wrong ⇒ mis-priced net edge. |
| `DHAN_BROKERAGE_MAX_PCT` | `0` | no | Cap brokerage as % of value (0 = off). | — |
| `DHAN_STT_SELL_PCT` | `0.1` | no | STT on sell side (%). | Statutory; change only on a rate change. |
| `DHAN_STT_ROUND_NEAREST_RUPEE` | `true` | no | Round STT to nearest rupee. | — |
| `DHAN_EXCHANGE_TXN_PCT` | `0.03503` | no | Exchange transaction charge (%). | Statutory. |
| `DHAN_IPFT_PER_CRORE` | `50` | no | IPFT per crore turnover (folded into exchange head). | Statutory. |
| `DHAN_SEBI_PCT` | `0.0001` | no | SEBI turnover charge (%). | Statutory. |
| `DHAN_STAMP_DUTY_BUY_PCT` | `0.003` | no | Stamp duty on buy side (%). | Statutory. |
| `DHAN_GST_PCT` | `18` | no | GST (%). | Statutory. |
| `DHAN_CHARGE_RATE_VERSION` | `dhan-nse-options-2026-04-01` | no | Label stamped on the charge record. | Cosmetic/audit. |

## Zerodha charge card (`src/box/localCharges.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_STT_TYPE` | `stt` | no | STT type label on the local charge record. | Cosmetic/audit. |
| `BOX_CHARGE_RATE_VERSION` | `zerodha-nse-options-2026-04-01` | no | Zerodha charge-card version label. | Cosmetic/audit. |

## Mongo projection (`src/outbox/mongo.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `MONGODB_URI` | — | no | Atlas connection string (reporting replica). Never logged. | Blank ⇒ export disabled; the rest of the system is unaffected. |
| `MONGO_EXPORT_ENABLED` | `true` | no | Master export switch. | Export runs only when `true` **and** `MONGODB_URI` set. |
| `MONGO_EXPORT_BATCH_SIZE` | `100` | no | Rows per drain batch. | — |
| `MONGO_EXPORT_INTERVAL_MS` | `1000` | no | Drain interval. | — |
| `MONGO_EXPORT_MAX_BACKOFF_MS` | `60000` | no | Max backoff when Atlas fails. | — |
| `MONGO_EXPORT_SERVER_SELECTION_TIMEOUT_MS` | `5000` | no | Bounded server-selection timeout. | Too high ⇒ slow drain when Atlas is down. |
| `MONGO_EXPORT_MAX_ATTEMPTS` | `10` | no | Attempts before a poison row is dead-lettered. | — |
| `MONGO_EXPORT_DB` | (parsed from URI, else `strikedge`) | no | Explicit target db. | — |

## Legacy import (`src/scripts/migrateBoxFromMongo.ts`)

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `LEGACY_BOX_MONGODB_URI` | — | import-only | Source legacy Box Mongo (read-only). | Only read by `npm run migrate:box-from-mongo`; unset elsewhere is fine. |

## Reservation identity (`src/box/reservations/identity.ts`)

`CALSPREAD_DEPLOYMENT_ID` and `CALSPREAD_INSTANCE_ID` are read by the **reservation
layer** — these are the actual names the code reads (`identity.ts` resolves the
lock namespace from `CALSPREAD_DEPLOYMENT_ID`, falling back to `NODE_ENV`, and the
instance label from `CALSPREAD_INSTANCE_ID`, falling back to the hostname). They
retain the `CALSPREAD_` prefix on purpose: the durable owner-id format is
unchanged from CalSpread so a mixed fleet reads the same keys.

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `CALSPREAD_DEPLOYMENT_ID` | `NODE_ENV` else `development` | no | Durable lock namespace. **Staging and production must not share one.** | Sharing ⇒ a laptop could take a lock the production process needs. |
| `CALSPREAD_INSTANCE_ID` | hostname | no | Host/replica label in owner ids and conflict logs. | Cosmetic but useful in logs. |

## Box strategy knobs (`src/box/config.ts`)

Every `BOX_*` strategy knob in `.env.example` is **optional**; the defaults are
the shipped specification and keep execution in `paper_latency`. The loader
validates and clamps each one and fails closed. The full annotated list lives in
`.env.example`; the ten calibration/live-timing variables are below.

### The ten calibration / live-timing variables

| Variable | Default | Req? | What it does | If wrong |
| --- | --- | --- | --- | --- |
| `BOX_PAPER_CALIBRATION_MIN_SAMPLES` | `30` | no | Min samples before the calibrated latency source is trusted overall (clamp 5..100000). | Too low ⇒ noisy calibration. |
| `BOX_PAPER_CALIBRATION_BUCKET_MIN_SAMPLES` | `60` | no | Min samples per time bucket (clamp 5..100000). | Too low ⇒ noisy per-bucket latency. |
| `BOX_PAPER_CALIBRATION_MAX_AGE_MS` | `604800000` | no | Max age (ms) a sample stays eligible (7 days). | Too small ⇒ calibration starves. |
| `BOX_PAPER_CALIBRATION_TIME_BUCKETS` | `true` | no | Bucket calibration by time of day. | `false` ⇒ one pooled distribution. |
| `BOX_PAPER_CANCEL_LATENCY_MS` | `150` | no | Simulated cancel latency (ms) in paper (clamp 0..60000). | Unrealistic paper cancel timing. |
| `BOX_LIVE_TIMING_PERSIST_ENABLED` | `false` | no | Persist live execution timing samples to PostgreSQL. | `true` ⇒ extra writes; needed to build a live calibration corpus. |
| `BOX_LIVE_TIMING_BATCH_SIZE` | `50` | no | Rows per live-timing flush batch (clamp 1..10000). | — |
| `BOX_LIVE_TIMING_FLUSH_MS` | `15000` | no | Live-timing flush interval (ms) (clamp 250..600000). | — |
| `BOX_EXECUTION_EVENT_LOOP_METRICS_ENABLED` | `true` | no | Emit event-loop lag metrics for the execution path. | `false` ⇒ blind to event-loop stalls. |
| `BOX_SHADOW_MODE_ENABLED` | `false` | no | Run live logic against paper fills with no broker contact. | Cannot combine with `BOX_EXECUTION_MODE=live` (loader refuses). |

---

## CalSpread variables that were REMOVED

StrikeEdge deliberately **does not read** the following CalSpread variables. They
belong to features that were left behind in the extraction, so shipping them in
`.env.example` would be a lie about what the process does. If any appear in a
copied `.env`, they are silently ignored.

| Removed variable(s) | Why it is gone |
| --- | --- |
| `KITE_API_SECRET` | StrikeEdge performs no Zerodha OAuth; it fetches a ready token from CalSpread. No secret is exchanged. |
| `ADMIN_SECRET` | The full-admin login is replaced by the site passcode session (`SITE_ACCESS_SECRET`) plus the runtime arming controls. |
| `ACCESS_SECRET` | The separate trade-access password is replaced by the single site passcode. |
| `INTERNAL_TOKEN_SECRET` | The `/api/internal/kite-token` route that fed a separate market-data recorder is gone. |
| `TOKEN_ROUTE_SECRET` | StrikeEdge does not host token routes; it is a **client** of CalSpread's, using `KITE_TOKEN_BROKER_PASSCODE` / `DHAN_TOKEN_BROKER_PASSCODE`. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis is removed entirely; the P&L and closed-trade caches are PostgreSQL-backed. |
| `TRADE_LOG_URI` | The calendar-spread ledger is out of scope. |
| `NSE_FNO_ARCHIVE_URI`, `NSE_FNO_CURRENT_URI`, `NSE_FNO_SPREAD_URI` | Historical F&O capture / spread computation are calendar-scanner features, not Box. |
| `EXTRA_SESSION_DAYS` | Only the intraday capture (removed) consumed the special-session list. |
| `BOX_MONGODB_URI` | Mongo is no longer the operational store; PostgreSQL (`DATABASE_URL`) is. Mongo is reporting-only via `MONGODB_URI`. |
| `DHAN_API_KEY`, `DHAN_API_SECRET`, `DHAN_REDIRECT_URL` | The Dhan OAuth/login flow is removed — tokens come from CalSpread's Dhan route. |
| `BOX_PNL_CACHE_ENABLED`, `BOX_PNL_CACHE_INTERVAL_MS`, `BOX_PNL_CACHE_TTL_SEC` | The Redis P&L cache is replaced by PostgreSQL persistence; these Redis-cache knobs no longer apply. |
| `BOX_PNL_ARCHIVE_DRAIN_DELAY_MS` / `BOX_PNL_VERIFY_HOURS` (Redis-archive knobs) | The Redis-backed P&L archive verification path is removed; P&L history lives in PostgreSQL. |

> Note on the `DHAN_*` OAuth variables: a dormant `src/brokers/dhan/auth.ts`
> still references `DHAN_API_KEY`/`DHAN_API_SECRET`/`DHAN_REDIRECT_URL`, but that
> login code path is never invoked in StrikeEdge (StrikeEdge does no broker
> OAuth). They are intentionally omitted from `.env.example` because setting them
> does nothing in this deployment.
