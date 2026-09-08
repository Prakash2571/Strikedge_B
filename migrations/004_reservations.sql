-- 004_reservations.sql — the durable instrument-reservation authority.
--
-- Replaces the CalSpread Mongo collection box_instrument_reservations. In Mongo the
-- entire safety property was a single UNIQUE MULTIKEY index over (deployment, keys):
-- one index entry per array element, so no (deployment, key) pair could exist in two
-- documents. PostgreSQL has no multikey array index, so the set is NORMALISED into a
-- child table with one row per canonical instrument key and a UNIQUE constraint on
-- (deployment_id, broker, instrument_key). All-or-none acquisition then falls out of
-- inserting every child row in ONE transaction: the first conflicting key aborts the
-- whole insert.
--
-- Fences come from a real PostgreSQL SEQUENCE (monotonic forever). Authority time is
-- clock_timestamp() taken inside the pgStore, never the Node clock. An advisory lock
-- is NEVER the reservation record — the rows here are.

/* ----------------------- box_reservation_owners ---------------------------- */
-- One row per live reservation: a complete instrument set held by one execution.
-- `owner` is the globally unique owner id and the primary key, so owner lookup is a
-- primary-key hit and owner uniqueness is enforced by the database.

CREATE TABLE IF NOT EXISTS box_reservation_owners (
  owner        text        PRIMARY KEY,
  deployment   text        NOT NULL,
  broker       text        NOT NULL,
  generation   numeric     NOT NULL,
  mode         text        NOT NULL DEFAULT '',
  fence        bigint      NOT NULL,
  instance     text        NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  renewed_at   timestamptz NOT NULL
);

-- Operator queries and generation-scoped housekeeping.
CREATE INDEX IF NOT EXISTS box_reservation_owners_scope
  ON box_reservation_owners (deployment, broker, generation);
-- Garbage collection only — logical expiry is decided from the stored timestamp, this
-- index just keeps the reaper's scan proportional to what has expired.
CREATE INDEX IF NOT EXISTS box_reservation_owners_expires_at
  ON box_reservation_owners (expires_at);
CREATE INDEX IF NOT EXISTS box_reservation_owners_deployment
  ON box_reservation_owners (deployment);

/* ------------------------ box_reservation_keys ----------------------------- */
-- One child row per canonical instrument key of an owner. THE safety property: a
-- (deployment_id, broker, instrument_key) tuple can exist at most once, so a contract
-- is held by at most one live reservation. `side` is diagnostic metadata for
-- describing a conflict; never a correctness input. ON DELETE CASCADE so releasing an
-- owner drops its keys in one step.

CREATE TABLE IF NOT EXISTS box_reservation_keys (
  deployment_id  text NOT NULL,
  broker         text NOT NULL,
  instrument_key text NOT NULL,
  owner          text NOT NULL REFERENCES box_reservation_owners(owner) ON DELETE CASCADE,
  side           text NOT NULL DEFAULT '',
  PRIMARY KEY (deployment_id, broker, instrument_key)
);

CREATE INDEX IF NOT EXISTS box_reservation_keys_owner ON box_reservation_keys (owner);

/* ---------------------- box_reservation_fence_seq -------------------------- */
-- Monotonic fencing token, forever. A genuine atomic increment against shared state
-- (nextval), not a local counter and not a timestamp: a token that can repeat or go
-- backwards cannot identify a stale owner, which is the only reason it exists. A
-- single global sequence is sufficient — fences only have to be strictly increasing.

CREATE SEQUENCE IF NOT EXISTS box_reservation_fence_seq AS bigint START 1;
