-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- SESSION ENTRY-ATTEMPT BUDGET — bound attempts, not only successful completions.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- WHY
--
-- `box_trading_session.max_completed_trades` bounds cycles CONSUMED when a full four-leg Box is
-- ESTABLISHED. An entry attempt that ended with no Box was recorded only in `aborted_attempts`,
-- which the code documented as "Visibility only; never gates anything".
--
-- Not spending a CYCLE on a failed attempt is right: burning an operator's single permitted trade
-- on an attempt that left no position would be indefensible. But it left NOTHING bounding attempts.
-- An attempt that submits orders, partially fills (real, irreversible exposure) and is then unwound
-- or recovered has taken real exposure, paid real charges and consumed real rate-limit budget — and
-- it was free. A deployment configured for "one bounded trial trade" could therefore submit orders
-- indefinitely so long as no attempt ever completed a Box, while still reporting one cycle left.
--
-- So there are now TWO independent budgets, and both gate new entry:
--   a CYCLE is spent by SUCCEEDING   (max_completed_trades / established_trade_ids)
--   an ATTEMPT is spent by STARTING  (max_entry_attempts / entry_attempts)
--
-- `entry_attempts` is incremented at ADMISSION, before any broker POST, and the write must land
-- before the attempt proceeds — an attempt that could not be counted would be an unbounded one.
-- Being a durable column is what makes "restart to get another attempt" not work.
--
-- ADDITIVE AND IDEMPOTENT: no existing column changes and no row is rewritten. Both columns default
-- to 0, which is the only safe reading for a row written by an earlier build:
--   max_entry_attempts = 0  ⇒ UNBOUNDED. Inventing a ceiling the operator never armed under would
--                             refuse entry they had legitimately authorised.
--   entry_attempts     = 0  ⇒ NONE SPENT. Inventing spent attempts would do the same.
-- The bound therefore takes effect from the next ARM, which is where the ceiling is snapshotted
-- (deliberately, so changing the env var and restarting cannot widen a session already armed under
-- a tighter limit). `normaliseSessionRecord()` in src/box/tradingSession.ts applies the same
-- defaulting in memory for any record that still lacks the fields.

ALTER TABLE box_trading_session
  ADD COLUMN IF NOT EXISTS entry_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE box_trading_session
  ADD COLUMN IF NOT EXISTS max_entry_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN box_trading_session.entry_attempts IS
  'Entry attempts STARTED by this armed session, counted at admission BEFORE any broker POST so a '
  'failed or recovered attempt still spends budget. Distinct from aborted_attempts, which counts '
  'only attempts that ended with no Box and gates nothing. Distinct from established_trade_ids, '
  'which counts attempts that SUCCEEDED. Durable so a restart cannot hand the budget back.';

COMMENT ON COLUMN box_trading_session.max_entry_attempts IS
  'The attempt ceiling SNAPSHOT taken when this session was armed (0 = unbounded). Snapshotted for '
  'the same reason as max_completed_trades: changing BOX_SESSION_MAX_ENTRY_ATTEMPTS and restarting '
  'must not retroactively widen a session an operator already armed under a tighter bound.';

-- Never negative. A negative counter would read as budget remaining; a negative ceiling would read
-- as unbounded. Both are cheaper to forbid here than to defend against at every read.
ALTER TABLE box_trading_session
  DROP CONSTRAINT IF EXISTS box_trading_session_entry_attempts_nonneg;

ALTER TABLE box_trading_session
  ADD CONSTRAINT box_trading_session_entry_attempts_nonneg CHECK (
    entry_attempts >= 0 AND max_entry_attempts >= 0
  );
