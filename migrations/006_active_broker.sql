-- 006_active_broker.sql — the durable, single-row record of which broker owns the
-- feed, the scanner and execution, plus the MONOTONIC broker generation.
--
-- WHY THE GENERATION HAD TO BECOME DURABLE
-- In CalSpread the generation lived only inside ActiveBrokerManager, initialised
-- to 1 at construction. That is fine as a cache key and WRONG as an identity:
-- after a restart the counter resets to 1, so "generation 1" could mean "Zerodha
-- before today's first switch" or "Dhan after two restarts". Durable instrument
-- reservations are STAMPED with the generation and refuse to authorise a
-- submission when it no longer matches — a check that is only meaningful if the
-- number never repeats for a different state of the world. A PostgreSQL sequence
-- guarantees exactly that: strictly increasing, never reused, monotonic across
-- restarts and across workers.
--
-- ONE ROW
-- Like the session store, this is a single-document table keyed by a constant.
-- `saveActiveBroker` advances the generation from the sequence and updates the row
-- atomically in one statement; `loadActiveBroker` reads it back.
--
-- SWITCHING DOES NOT RESET DAILY RISK
-- Nothing about the daily risk counters lives here. This row records selection and
-- identity only, so a broker switch cannot silently reset a day's risk budget.

CREATE SEQUENCE IF NOT EXISTS active_broker_generation_seq AS bigint START 1;

CREATE TABLE IF NOT EXISTS active_broker (
  -- Constant 'current': exactly one row.
  id            text        PRIMARY KEY DEFAULT 'current',

  -- 'zerodha' or 'dhan'.
  broker        text        NOT NULL,

  -- Monotonic, never reset, sourced from active_broker_generation_seq.
  generation    bigint      NOT NULL,

  selected_at   timestamptz NOT NULL DEFAULT now(),

  -- Who/what made the selection: 'boot_default', 'morning_default', an operator id,
  -- or 'system'. Free text, bounded.
  selected_by   text        NOT NULL DEFAULT 'system',

  -- Human-readable reason, e.g. 'fresh deployment default', 'manual switch'.
  reason        text,

  -- IST YYYY-MM-DD the selection was last made on, for day-roll reporting.
  trading_day   text        NOT NULL DEFAULT '',

  CONSTRAINT active_broker_singleton CHECK (id = 'current'),
  CONSTRAINT active_broker_valid CHECK (broker IN ('zerodha', 'dhan')),
  CONSTRAINT active_broker_generation_positive CHECK (generation > 0),
  CONSTRAINT active_broker_selected_by_bounded CHECK (length(selected_by) <= 200),
  CONSTRAINT active_broker_reason_bounded CHECK (reason IS NULL OR length(reason) <= 500)
);
