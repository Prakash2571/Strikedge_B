-- 003_box_pnl_settings_session.sql — the reporting/archive and singleton tables.
--
-- box_daily_pnl        the day-bounded P&L archive (per-trade rows + a per-day summary)
-- box_pnl_deletions    durable reporting-cleanup fences
-- box_pnl_day_states   the completeness manifest / exact-content proof per day
-- box_settings         admin-set numeric thresholds
-- box_trading_session  the singleton one-shot armed-session record
-- box_calibration_samples  anonymised execution-latency observations
--
-- These replace the same-named CalSpread collections. The Redis P&L tier that used
-- to mirror the running day is GONE; PostgreSQL (box_daily_pnl here) is the durable
-- tier. See docs/PG_PERSISTENCE.md.

/* ------------------------------ box_daily_pnl ------------------------------ */
-- Two record kinds share the table, distinguished by trade_id: a per-trade row
-- (real trade id) or the day summary (trade_id = '__summary__', carrying `summary`).
-- One row per (day, trade_id) — the upsert key that makes re-draining idempotent.

CREATE TABLE IF NOT EXISTS box_daily_pnl (
  day                 text        NOT NULL,
  trade_id            text        NOT NULL,
  underlying          text        NOT NULL DEFAULT '',
  direction           text        NOT NULL DEFAULT 'LONG_BOX',
  lower_strike        numeric     NOT NULL DEFAULT 0,
  upper_strike        numeric     NOT NULL DEFAULT 0,
  expiry              text        NOT NULL DEFAULT '',
  status              text        NOT NULL DEFAULT 'open',
  gross_pnl           numeric,
  net_pnl             numeric,
  realisable_net_pnl  numeric,
  realised_net_pnl    numeric,
  opened_at           text,
  closed_at           text,
  updated_at          text,
  -- JSONB: the per-day aggregate, present only on the '__summary__' row.
  summary             jsonb,
  archived_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, trade_id)
);

-- Cross-day deletion cleanup pages by trade without scanning the whole archive.
CREATE INDEX IF NOT EXISTS box_daily_pnl_trade_day ON box_daily_pnl (trade_id, day);

/* ----------------------------- box_pnl_deletions --------------------------- */
-- Durable per-trade reporting-cleanup intents and permanent deletion fences.
-- Completed fences are retained forever so late writers cannot resurrect P&L.

CREATE TABLE IF NOT EXISTS box_pnl_deletions (
  trade_id       text        PRIMARY KEY,
  status         text        NOT NULL DEFAULT 'pending',
  candidate_days jsonb       NOT NULL DEFAULT '[]'::jsonb,
  attempts       integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  last_error     text,
  CONSTRAINT box_pnl_deletions_status_ck CHECK (status IN ('pending', 'complete'))
);

CREATE INDEX IF NOT EXISTS box_pnl_deletions_status_id ON box_pnl_deletions (status, trade_id);

/* ---------------------------- box_pnl_day_states --------------------------- */
-- Completion manifest / exact-content proof per archived day. snapshot_version 2 is
-- the count + sha256 proof; expected_trade_ids is the read-only legacy v1 manifest.

CREATE TABLE IF NOT EXISTS box_pnl_day_states (
  day                text        PRIMARY KEY,
  complete           boolean     NOT NULL DEFAULT false,
  snapshot_version   integer,
  row_count          integer,
  content_sha256     text,
  needs_reproof      boolean     NOT NULL DEFAULT false,
  expected_trade_ids jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS box_pnl_day_states_v2_complete_id
  ON box_pnl_day_states (snapshot_version, complete, day);
CREATE INDEX IF NOT EXISTS box_pnl_day_states_v2_reproof_id
  ON box_pnl_day_states (snapshot_version, needs_reproof, day);

/* ------------------------------- box_settings ------------------------------ */
-- One admin-set numeric threshold per key, persisted so it survives a restart.

CREATE TABLE IF NOT EXISTS box_settings (
  key        text        PRIMARY KEY,
  value      numeric     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

/* --------------------------- box_trading_session --------------------------- */
-- A SINGLE row (id = 'current'). One armed one-shot session per deployment. Durable
-- for a SAFETY reason: BOX_SESSION_MAX_COMPLETED_TRADES=1 must not be resettable by
-- restarting Node. No TTL: a consumed one-shot stays consumed until re-armed.

CREATE TABLE IF NOT EXISTS box_trading_session (
  id                    text        PRIMARY KEY,
  session_id            text        NOT NULL DEFAULT '',
  armed_at              timestamptz,
  armed_by              text,
  max_completed_trades  numeric     NOT NULL DEFAULT 0,
  established_trade_ids jsonb       NOT NULL DEFAULT '[]'::jsonb,
  completed_trade_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  aborted_attempts      numeric     NOT NULL DEFAULT 0,
  arm_count             numeric     NOT NULL DEFAULT 0,
  updated_at            timestamptz
);

/* -------------------------- box_calibration_samples ------------------------ */
-- Anonymised execution-latency observations. No credentials, tokens, or position
-- data. Region-scoped rehydration read; bounded by age at query time.

CREATE TABLE IF NOT EXISTS box_calibration_samples (
  id          bigserial   PRIMARY KEY,
  broker      text        NOT NULL,
  kind        text        NOT NULL,
  profile     text        NOT NULL,
  bucket      text        NOT NULL,
  stage       text        NOT NULL,
  value_ms    numeric     NOT NULL,
  session     text        NOT NULL,
  region      text,
  observed_at timestamptz NOT NULL
);

-- Read path: "recent samples for this region".
CREATE INDEX IF NOT EXISTS box_calibration_region_recent
  ON box_calibration_samples (region, observed_at DESC);
CREATE INDEX IF NOT EXISTS box_calibration_observed_at_idx
  ON box_calibration_samples (observed_at);
