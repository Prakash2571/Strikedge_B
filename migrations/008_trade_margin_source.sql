-- 008_trade_margin_source.sql — persist WHICH margin model produced a trade's figure.
--
-- WHY THIS IS A CORRECTNESS FIX, NOT A NICETY
-- `box_trades.margin` stores one number and, until now, nothing recorded where it came
-- from. The four brokers' models are not interchangeable:
--
--   kite_basket           Zerodha's basket-margin API — position-aware and netted.
--   dhan_multi            Dhan's multi-order calculator — hedge-adjusted, preferred.
--   dhan_per_leg_fallback Dhan per-leg margins SUMMED. A conservative UPPER bound that
--                         materially OVER-STATES a hedged four-leg Box.
--   unavailable           No figure could be obtained.
--
-- `src/box/engine.ts` already warned on the console when it fell back to the per-leg sum,
-- and its own comment said the quiet part out loud: "Only `res.total` is persisted, so once
-- stored an inflated per-leg sum is indistinguishable from a real basket margin — and it is
-- plausible enough to go unnoticed." That is exactly what the specification means by
-- "Never silently use Dhan per-leg margin as if it were hedge-adjusted basket margin.
-- Persist the margin source."
--
-- NULL IS MEANINGFUL and is deliberately the default for existing rows: it means "recorded
-- before provenance was captured", which is honestly different from `unavailable` ("we
-- asked and got nothing"). Back-filling a guess would manufacture provenance that was
-- never observed, which is the failure this column exists to prevent.
--
-- Additive and repeatable: no existing column changes, no row is rewritten, and the
-- migration runner applies it exactly once.

ALTER TABLE box_trades
  ADD COLUMN IF NOT EXISTS margin_source text;

COMMENT ON COLUMN box_trades.margin_source IS
  'Which margin model produced box_trades.margin: kite_basket | dhan_multi | '
  'dhan_per_leg_fallback | unavailable. NULL means the trade predates provenance capture, '
  'which is distinct from ''unavailable''. A dhan_per_leg_fallback figure OVER-STATES a '
  'hedged Box and must never be read as a netted basket margin.';

-- Constrain to the known set, but ALLOW NULL. A CHECK rather than an enum so a future
-- broker model is a one-line migration and never an enum-rewrite of a live table.
ALTER TABLE box_trades
  DROP CONSTRAINT IF EXISTS box_trades_margin_source_known;

ALTER TABLE box_trades
  ADD CONSTRAINT box_trades_margin_source_known CHECK (
    margin_source IS NULL
    OR margin_source IN ('kite_basket', 'dhan_multi', 'dhan_per_leg_fallback', 'unavailable')
  );

-- Answers "how much of today's margin came from a conservative fallback rather than a real
-- netted figure?" without scanning the history. Partial, so it stays proportional to the
-- rows that actually carry provenance.
CREATE INDEX IF NOT EXISTS box_trades_margin_source_idx
  ON box_trades (margin_source)
  WHERE margin_source IS NOT NULL;
