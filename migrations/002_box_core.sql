-- 002_box_core.sql — the operational Box tables.
--
-- These replace the CalSpread Mongoose collections box_trades, box_trade_events,
-- box_order_intents and box_execution_attempts. The Mongoose schemas in
-- Cal_Spread_Backend/src/box/model.ts are the authoritative column list; anything
-- that a query, a uniqueness guard, a state transition, recovery, reconciliation,
-- partial-fill attribution, a position quantity, a sort/filter or daily-risk reads
-- is a NORMALISED SCALAR column here. Only large nested audit payloads that are
-- never used as a concurrency guard (depth snapshots, raw broker payloads, charge
-- breakdowns, per-attempt exit audits) are JSONB.
--
-- Every operational table carries a `broker` column ('zerodha' | 'dhan') because
-- StrikeEdge is dual-broker. Legacy documents had no broker field and were, by
-- construction, Zerodha's; the DEFAULT 'zerodha' preserves that (see LEGACY_BROKER).
--
-- All timestamps are timestamptz, all money/quantities are numeric.

-- A named domain for the broker discriminator so every table agrees on the values.
-- The guard is schema-aware (current_schema) so applying the migration into a fresh
-- schema — as the test harness does for isolation — always creates the domain there.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'box_broker' AND n.nspname = current_schema()
  ) THEN
    CREATE DOMAIN box_broker AS text
      CHECK (VALUE IN ('zerodha', 'dhan'));
  END IF;
END$$;

/* ------------------------------- box_trades -------------------------------- */

CREATE TABLE IF NOT EXISTS box_trades (
  id                          text        PRIMARY KEY,
  broker                      box_broker  NOT NULL DEFAULT 'zerodha',
  execution_mode              text        NOT NULL DEFAULT 'paper_touch',

  underlying                  text        NOT NULL,
  name                        text        NOT NULL DEFAULT '',
  is_index                    boolean     NOT NULL DEFAULT false,
  expiry                      text        NOT NULL,
  direction                   text        NOT NULL DEFAULT 'LONG_BOX',

  lower_strike                numeric     NOT NULL,
  upper_strike                numeric     NOT NULL,
  lot_size                    numeric     NOT NULL,
  quantity                    numeric     NOT NULL,

  status                      text        NOT NULL DEFAULT 'open',

  box_width                   numeric     NOT NULL,
  margin                      numeric,

  entry_box_cost              numeric     NOT NULL,
  entry_gross_edge            numeric     NOT NULL,
  safety_buffer               numeric     NOT NULL DEFAULT 0,
  entry_net_edge              numeric     NOT NULL,
  expected_net_profit         numeric,
  entry_execution_cost        numeric,
  charge_origin               text        NOT NULL DEFAULT 'local',
  charge_rate_version         text,

  -- position accounting used by adoption / partial-exit attribution
  position_state              text,
  cumulative_exit_charges     numeric,

  opened_at                   timestamptz NOT NULL DEFAULT now(),

  current_remaining_edge      numeric,
  current_captured_edge       numeric,
  current_captured_pct        numeric,

  exit_box_value              numeric,
  gross_pnl                   numeric,
  total_charges               numeric,
  net_pnl                     numeric,
  realised_net_pnl            numeric,

  closed_at                   timestamptz,
  close_idempotency_key       text,
  exit_reason                 text,
  exit_blocked_reason         text,
  expiry_safety               boolean     NOT NULL DEFAULT false,

  error                       text,

  -- JSONB: nested audit payloads and structured sub-documents never used as a
  -- concurrency guard. `legs` holds the four IBoxLeg records (with their depth
  -- ladders); charge documents keep the full contract-note breakdown.
  legs                        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  entry_charges               jsonb,
  estimated_exit_charges      jsonb,
  exit_charges                jsonb,
  entry_charge_reconciliation jsonb,
  exit_charge_reconciliation  jsonb,
  entry_execution             jsonb,
  entry_legging               jsonb,
  exit_execution              jsonb,
  exit_legging                jsonb,
  residual_exposure           jsonb,
  remaining_qty_by_role       jsonb,
  exit_attempts               jsonb,
  scanner_config_snapshot     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT box_trades_status_ck CHECK (status IN ('open', 'closed', 'error')),
  CONSTRAINT box_trades_direction_ck CHECK (direction IN ('LONG_BOX', 'SHORT_BOX')),
  CONSTRAINT box_trades_position_state_ck
    CHECK (position_state IS NULL OR position_state IN ('BOX', 'PARTIALLY_EXITED', 'RECOVERY', 'FLAT'))
);

-- ONE OPEN box per exact strike pair AND DIRECTION, per broker. The partial unique
-- index is the atomic half of duplicate protection: even if two ticks race past the
-- in-memory guard, the second insert is rejected. Closed trades are excluded so the
-- same box can be traded again later. `broker` leads because StrikeEdge is dual-broker
-- and a Zerodha box and a Dhan box on identical strikes are distinct positions.
CREATE UNIQUE INDEX IF NOT EXISTS box_open_unique_pair_dir
  ON box_trades (broker, underlying, expiry, lower_strike, upper_strike, direction)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS box_trades_opened_at_idx ON box_trades (opened_at DESC);
-- Serves the Closed-trades sort (status leads so the {status, closed_at} read is
-- index-driven, exactly like the Mongo compound index).
CREATE INDEX IF NOT EXISTS box_trades_status_closed_at_idx ON box_trades (status, closed_at DESC);
CREATE INDEX IF NOT EXISTS box_trades_broker_idx ON box_trades (broker);
CREATE INDEX IF NOT EXISTS box_trades_underlying_idx ON box_trades (underlying);

/* ---------------------------- box_trade_events ----------------------------- */

CREATE TABLE IF NOT EXISTS box_trade_events (
  id                  bigserial   PRIMARY KEY,
  event               text        NOT NULL,
  at                  timestamptz NOT NULL DEFAULT now(),
  trade_id            text,
  candidate_key       text        NOT NULL DEFAULT '',
  underlying          text        NOT NULL DEFAULT '',
  expiry              text        NOT NULL DEFAULT '',
  direction           text        NOT NULL DEFAULT 'LONG_BOX',
  lower_strike        numeric     NOT NULL DEFAULT 0,
  upper_strike        numeric     NOT NULL DEFAULT 0,
  lot_size            numeric     NOT NULL DEFAULT 0,
  quantity            numeric     NOT NULL DEFAULT 0,
  execution_mode      text        NOT NULL DEFAULT 'paper_touch',
  broker              box_broker  NOT NULL DEFAULT 'zerodha',

  box_width           numeric,
  box_cost            numeric,
  gross_edge          numeric,
  entry_charges_total numeric,
  exit_charges_total  numeric,
  safety_buffer       numeric,
  net_edge            numeric,
  expected_net_profit numeric,
  execution_cost      numeric,
  gross_pnl           numeric,
  net_pnl             numeric,
  remaining_edge      numeric,
  captured_edge       numeric,
  captured_pct        numeric,

  reason              text,
  detail              text,

  -- JSONB: append-only audit blobs.
  execution           jsonb,
  legs                jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS box_trade_events_at_idx ON box_trade_events (at DESC);
CREATE INDEX IF NOT EXISTS box_trade_events_trade_id_idx ON box_trade_events (trade_id);
CREATE INDEX IF NOT EXISTS box_trade_events_event_idx ON box_trade_events (event);
CREATE INDEX IF NOT EXISTS box_trade_events_candidate_idx ON box_trade_events (candidate_key);

/* ---------------------------- box_order_intents ---------------------------- */

CREATE TABLE IF NOT EXISTS box_order_intents (
  id                        text        PRIMARY KEY,
  client_order_id           text        NOT NULL,
  broker_order_id           text,
  broker_mode               text        NOT NULL,
  broker                    box_broker  NOT NULL DEFAULT 'zerodha',
  broker_correlation_id     text,
  trade_id                  text,
  attempt_id                text        NOT NULL,
  role                      text        NOT NULL,
  purpose                   text        NOT NULL,
  phase                     text        NOT NULL,
  exchange                  text        NOT NULL,
  tradingsymbol             text        NOT NULL,
  token                     numeric     NOT NULL,
  side                      text        NOT NULL,
  quantity                  numeric     NOT NULL,
  reference_price           numeric     NOT NULL,
  tick_size                 numeric     NOT NULL,
  max_chase_ticks           numeric     NOT NULL,
  limit_price               numeric     NOT NULL,
  state                     text        NOT NULL DEFAULT 'CREATED',
  filled_quantity           numeric     NOT NULL DEFAULT 0,
  -- Pre-image of filled_quantity stamped by the most recent guarded CAS write, so
  -- fill attribution is a property of the durable transition, never a caller snapshot.
  previous_filled_quantity  numeric,
  average_price             numeric,
  broker_tag                text,
  reject_family             text,
  reject_reason             text,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  terminal_at               timestamptz,
  -- JSONB: append-only audit ledger of transitions embedded on the row, matching
  -- the CalSpread `audit` array shape read back by callers.
  audit                     jsonb       NOT NULL DEFAULT '[]'::jsonb,

  CONSTRAINT box_order_intents_broker_mode_ck CHECK (broker_mode IN ('paper', 'live')),
  CONSTRAINT box_order_intents_role_ck CHECK (role IN ('k1_ce', 'k2_ce', 'k2_pe', 'k1_pe')),
  CONSTRAINT box_order_intents_purpose_ck
    CHECK (purpose IN ('ENTRY', 'EXIT', 'EMERGENCY_RESIDUAL', 'PROTECTIVE_CANCEL')),
  CONSTRAINT box_order_intents_phase_ck CHECK (phase IN ('entry', 'exit', 'unwind')),
  CONSTRAINT box_order_intents_side_ck CHECK (side IN ('BUY', 'SELL')),
  CONSTRAINT box_order_intents_state_ck CHECK (state IN (
    'CREATED', 'SUBMITTING', 'ACKNOWLEDGED', 'OPEN', 'PARTIALLY_FILLED',
    'COMPLETE', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'UNKNOWN',
    'RECONCILIATION_REQUIRED'
  )),
  -- Cumulative filled quantity can never regress and can never exceed the order size.
  CONSTRAINT box_order_intents_filled_nonneg CHECK (filled_quantity >= 0),
  CONSTRAINT box_order_intents_filled_le_qty CHECK (filled_quantity <= quantity),
  CONSTRAINT box_order_intents_prev_fill_monotonic
    CHECK (previous_filled_quantity IS NULL OR filled_quantity >= previous_filled_quantity)
);

-- client_order_id GLOBALLY unique.
CREATE UNIQUE INDEX IF NOT EXISTS box_order_intent_client_order_id
  ON box_order_intents (client_order_id);
-- broker_order_id unique WITHIN broker, only when non-null (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS box_order_intent_broker_order_id
  ON box_order_intents (broker, broker_order_id)
  WHERE broker_order_id IS NOT NULL;
-- broker correlation id unique within broker when supplied.
CREATE UNIQUE INDEX IF NOT EXISTS box_order_intent_broker_correlation_id
  ON box_order_intents (broker, broker_correlation_id)
  WHERE broker_correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS box_order_intent_trade_id_idx ON box_order_intents (trade_id, created_at DESC);
CREATE INDEX IF NOT EXISTS box_order_intent_attempt_id_idx ON box_order_intents (attempt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS box_order_intent_state_idx ON box_order_intents (state, updated_at);

-- Immutable order-intent fields cannot change after creation. Enforced with a BEFORE
-- UPDATE trigger that raises, in addition to the in-code assertIntentImmutableMatch
-- check. This is the durable half: even a defective code path cannot mutate identity.
CREATE OR REPLACE FUNCTION box_order_intents_assert_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.client_order_id  IS DISTINCT FROM OLD.client_order_id
  OR NEW.broker_mode      IS DISTINCT FROM OLD.broker_mode
  OR NEW.trade_id         IS DISTINCT FROM OLD.trade_id
  OR NEW.attempt_id       IS DISTINCT FROM OLD.attempt_id
  OR NEW.role             IS DISTINCT FROM OLD.role
  OR NEW.purpose          IS DISTINCT FROM OLD.purpose
  OR NEW.phase            IS DISTINCT FROM OLD.phase
  OR NEW.exchange         IS DISTINCT FROM OLD.exchange
  OR NEW.tradingsymbol    IS DISTINCT FROM OLD.tradingsymbol
  OR NEW.token            IS DISTINCT FROM OLD.token
  OR NEW.side             IS DISTINCT FROM OLD.side
  OR NEW.quantity         IS DISTINCT FROM OLD.quantity
  OR NEW.reference_price  IS DISTINCT FROM OLD.reference_price
  OR NEW.tick_size        IS DISTINCT FROM OLD.tick_size
  OR NEW.max_chase_ticks  IS DISTINCT FROM OLD.max_chase_ticks
  OR NEW.limit_price      IS DISTINCT FROM OLD.limit_price
  THEN
    RAISE EXCEPTION 'box_order_intents immutable field changed for client_order_id %', OLD.client_order_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS box_order_intents_immutable_trg ON box_order_intents;
CREATE TRIGGER box_order_intents_immutable_trg
  BEFORE UPDATE ON box_order_intents
  FOR EACH ROW EXECUTE FUNCTION box_order_intents_assert_immutable();

/* ---------------------- box_order_intent_transitions ----------------------- */
-- Audit of every applied state transition. `audit_id` is unique so an idempotent
-- replay of the same transition upserts nothing new (the CAS embeds the same id in
-- the row's `audit` array; this table is the queryable, append-only projection).

CREATE TABLE IF NOT EXISTS box_order_intent_transitions (
  audit_id        text        PRIMARY KEY,
  client_order_id text        NOT NULL,
  intent_id       text        NOT NULL,
  at              timestamptz NOT NULL,
  from_state      text,
  to_state        text        NOT NULL,
  broker_order_id text,
  message         text,
  fill_identity   text,
  payload         jsonb
);

CREATE INDEX IF NOT EXISTS box_order_intent_transitions_intent_idx
  ON box_order_intent_transitions (intent_id, at);

/* -------------------------- box_execution_attempts ------------------------- */

CREATE TABLE IF NOT EXISTS box_execution_attempts (
  id                          text        PRIMARY KEY,
  candidate_key               text        NOT NULL DEFAULT '',
  direction                   text        NOT NULL DEFAULT 'LONG_BOX',
  underlying                  text        NOT NULL DEFAULT '',
  name                        text        NOT NULL DEFAULT '',
  is_index                    boolean     NOT NULL DEFAULT false,
  expiry                      text        NOT NULL DEFAULT '',
  lower_strike                numeric     NOT NULL DEFAULT 0,
  upper_strike                numeric     NOT NULL DEFAULT 0,
  lot_size                    numeric     NOT NULL DEFAULT 0,
  quantity                    numeric     NOT NULL DEFAULT 0,
  execution_mode              text        NOT NULL DEFAULT 'paper_legging',
  broker                      box_broker  NOT NULL DEFAULT 'zerodha',
  leg_execution_mode          text,
  detected_at                 timestamptz NOT NULL DEFAULT now(),
  resolved_at                 timestamptz NOT NULL DEFAULT now(),
  detected_gross_edge         numeric,
  expected_net_profit         numeric,
  filled_leg_count            numeric     NOT NULL DEFAULT 0,
  failed_legs                 jsonb       NOT NULL DEFAULT '[]'::jsonb,
  failure_reason              text,
  failure_detail              text,
  abort_after_fill            boolean     NOT NULL DEFAULT false,
  outcome_class               text,
  required_expected_net_profit numeric,
  charge_rate_version         text,
  partial_entry_charges       numeric,
  unwind_charges              numeric,
  flatten_charges             numeric     NOT NULL DEFAULT 0,
  flatten_charge_day          text,
  flatten_charges_for_day     numeric     NOT NULL DEFAULT 0,
  projection_version          numeric     NOT NULL DEFAULT 0,
  residual_projection_identity text,
  applied_flatten_applications jsonb      NOT NULL DEFAULT '[]'::jsonb,
  gross_abort_pnl             numeric,
  net_abort_pnl               numeric,
  resolved                    boolean     NOT NULL DEFAULT true,

  -- JSONB: append-only per-leg legging audit and outstanding residual exposure.
  legging                     jsonb,
  residual_exposure           jsonb,

  CONSTRAINT box_execution_attempts_filled_nonneg CHECK (filled_leg_count >= 0),
  CONSTRAINT box_execution_attempts_flatten_nonneg CHECK (flatten_charges >= 0),
  CONSTRAINT box_execution_attempts_flatten_day_nonneg CHECK (flatten_charges_for_day >= 0),
  CONSTRAINT box_execution_attempts_projection_version_nonneg CHECK (projection_version >= 0)
);

CREATE INDEX IF NOT EXISTS box_execution_attempts_resolved_at_idx
  ON box_execution_attempts (resolved_at DESC);
CREATE INDEX IF NOT EXISTS box_execution_attempts_resolved_idx
  ON box_execution_attempts (resolved, resolved_at DESC);
CREATE INDEX IF NOT EXISTS box_execution_attempts_underlying_idx
  ON box_execution_attempts (underlying);
CREATE INDEX IF NOT EXISTS box_execution_attempts_candidate_idx
  ON box_execution_attempts (candidate_key);
-- Today's residual-flatten charge buckets, largest same-day debit first — the shape
-- the daily-risk seed reads and bounds.
CREATE INDEX IF NOT EXISTS box_execution_attempt_flatten_charge_day
  ON box_execution_attempts (flatten_charge_day, flatten_charges_for_day DESC);

-- AT MOST ONE unresolved crash-only recovery boundary may exist at a time. This is
-- the SQL that ports BOX_RECOVERY_UNIQUE_INDEX / the single-unresolved-crash-recovery
-- guarantee: it prevents workers with slightly different reconstructed snapshots from
-- minting competing recovery rows.
CREATE UNIQUE INDEX IF NOT EXISTS box_single_unresolved_crash_recovery
  ON box_execution_attempts (candidate_key)
  WHERE candidate_key = 'boot-recovery' AND resolved = false;
