-- 001_outbox.sql — the PostgreSQL -> MongoDB transactional outbox.
--
-- WHY IT IS MIGRATION 001
-- Every operational migration that follows writes projection events through this
-- table, so it has to exist first. It is also the one table whose contract the
-- rest of the schema depends on rather than the other way round: nothing here
-- references a box table, which keeps the projector independently deployable.
--
-- THE CONTRACT
-- A row is inserted in the SAME transaction as the operational write it describes.
-- That is the whole point: after COMMIT the fact and its projection intent are
-- either both durable or neither is, so a crash between "PostgreSQL committed" and
-- "Mongo acknowledged" is recoverable by definition. MongoDB Atlas is therefore
-- never on the execution hot path and is never required before a broker POST.
--
-- IDEMPOTENCY
-- `event_id` is the stable identity the projector writes to Mongo as `_id`. A
-- redelivery therefore upserts the same document instead of appending a second
-- trade event or a duplicate P&L row.
--
-- ORDERING
-- `(aggregate_type, aggregate_id, sequence)` gives a per-aggregate order. The
-- projector claims work with FOR UPDATE SKIP LOCKED but respects this ordering
-- within one aggregate, because a trade's CLOSED event must not land before its
-- OPENED event.
--
-- NO SECRETS
-- `payload` must never carry a broker access token, an access-session token, the
-- site passcode, a CSRF secret or a database credential. That is enforced in code
-- (`src/outbox/writer.ts` rejects known secret-bearing keys) and asserted by
-- `tests/projector/noSecrets.test.mjs`; the comment is here so a future migration
-- author sees the rule at the schema.

CREATE TABLE IF NOT EXISTS mongo_outbox (
  -- Stable, immutable projection identity. Becomes the Mongo `_id`.
  event_id        text        PRIMARY KEY,

  -- What the event is about: 'box_trade' | 'box_trade_event' | 'box_order_intent'
  -- | 'box_execution_attempt' | 'box_daily_pnl' | 'box_calibration_sample'.
  aggregate_type  text        NOT NULL,
  aggregate_id    text        NOT NULL,

  -- Domain event name, e.g. 'trade_opened', 'intent_transitioned'.
  event_type      text        NOT NULL,

  -- Bumped whenever the projected document shape changes, and copied onto the
  -- Mongo document so a reader can tell which writer produced it.
  schema_version  integer     NOT NULL DEFAULT 1,

  -- Monotonic per aggregate. Sourced from a sequence so two concurrent writers on
  -- the same aggregate cannot both claim the same slot.
  sequence        bigint      NOT NULL,

  payload         jsonb       NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),

  -- Delivery bookkeeping.
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at    timestamptz,
  last_error      text,

  -- Set once a row has exhausted its attempt budget. A dead-lettered row is still
  -- visible in diagnostics and can be replayed by hand; it is never deleted, and
  -- it never blocks the rows behind it.
  dead_lettered_at timestamptz,

  CONSTRAINT mongo_outbox_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT mongo_outbox_sequence_positive CHECK (sequence > 0),
  CONSTRAINT mongo_outbox_last_error_bounded CHECK (last_error IS NULL OR length(last_error) <= 500)
);

-- The sequence behind `sequence`. Global rather than per-aggregate: it only has to
-- be monotonic, and a single sequence is cheap and never contends meaningfully.
CREATE SEQUENCE IF NOT EXISTS mongo_outbox_sequence_seq AS bigint START 1;

-- The projector's claim query: unpublished, not dead-lettered, due now, oldest
-- first. A partial index keeps it proportional to the BACKLOG rather than to the
-- history, which matters because published rows are retained for auditing.
CREATE INDEX IF NOT EXISTS mongo_outbox_pending_idx
  ON mongo_outbox (next_attempt_at, sequence)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

-- Per-aggregate ordering lookups and the "is anything for this trade still
-- pending" question the switch-blocker report asks.
CREATE INDEX IF NOT EXISTS mongo_outbox_aggregate_idx
  ON mongo_outbox (aggregate_type, aggregate_id, sequence);

-- Dead-letter visibility.
CREATE INDEX IF NOT EXISTS mongo_outbox_dead_letter_idx
  ON mongo_outbox (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;
