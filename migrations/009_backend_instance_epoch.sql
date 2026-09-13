-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BACKEND INSTANCE EPOCH — a restart-durable, strictly increasing ordinal per process boot.
-- ─────────────────────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS EXISTS
--
-- The readiness decision carries `decision_generation`, a counter the engine increments once per
-- decision. It is PROCESS-LOCAL: `private readinessDecisionGeneration = 0`. The frontend accepts a
-- decision only when its generation is strictly greater than the one already rendered, which is
-- correct for ordering concurrent responses from ONE process and completely wrong across a restart:
--
--     browser has rendered generation 5000
--     backend restarts, its counter resets, it publishes generation 1
--     5000 > 1, so the browser rejects 1 — and 2, and 3, and every decision thereafter,
--     indefinitely, until someone reloads the page.
--
-- A stuck dashboard is not merely cosmetic here: the operator is looking at a permission verdict
-- from a process that no longer exists, and it says "entry permitted" long after the new process has
-- decided otherwise.
--
-- WHY AN ORDINAL AND NOT A RANDOM INSTANCE ID
--
-- A random per-boot id tells a client the instance CHANGED but not which one is NEWER, so a client
-- would either have to trust any unfamiliar id (and then a delayed response from the OLD process
-- would be adopted as new, which is the same bug pointing the other way) or trust none. Ordering
-- needs an ordering, so this is a monotonically increasing integer that survives restarts.
--
-- WHY POSTGRESQL AND NOT A CLOCK
--
-- Wall clocks are not usable for correctness here: an NTP step, a VM snapshot restore, or a
-- container starting with a skewed clock would each produce a "newer" instance that is older. PG is
-- already the operational authority in this system, so the ordinal is minted by the same authority
-- that orders everything else, and it needs no synchronised clock to be correct.
--
-- WHEN PG IS UNAVAILABLE AT BOOT the backend publishes a NULL ordinal, and the frontend treats a
-- null-ordinal decision as UNORDERABLE: it will not let it overwrite an ordered decision, and it
-- disables new entry with that reason. That is the safe reading — a backend that cannot reach the
-- authoritative store must not be authorising new exposure anyway.
--
-- SINGLE-INSTANCE TOPOLOGY. `ecosystem.config.cjs` deliberately runs ONE fork-mode process, and the
-- readiness ordering assumes it. Two processes sharing this table each take a DISTINCT ordinal (the
-- UPDATE ... RETURNING below is atomic), so they can never claim the same epoch; a client seeing two
-- different instance ids at the same ordinal treats it as an incompatible topology and refuses,
-- rather than silently interleaving two processes' verdicts. See docs/CONFIGURATION.md.

CREATE TABLE IF NOT EXISTS backend_instance_epoch (
  -- Single-row table. The CHECK makes a second row impossible rather than merely unexpected.
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- The last ordinal handed out. Incremented and returned atomically on every boot.
  last_ordinal bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE backend_instance_epoch IS
  'Restart-durable, strictly increasing ordinal handed to each backend process at boot. Published '
  'in box-status.operational_readiness.instance.boot_ordinal so a client can order readiness '
  'decisions ACROSS restarts, which a process-local decision_generation cannot. Not a clock: an '
  'NTP step or a snapshot restore must not be able to make an older instance look newer.';

COMMENT ON COLUMN backend_instance_epoch.last_ordinal IS
  'The highest ordinal issued. A boot performs UPDATE ... SET last_ordinal = last_ordinal + 1 '
  'RETURNING last_ordinal, so two concurrent boots receive DISTINCT ordinals and neither can '
  'observe the other''s value.';

-- Seed the single row. Idempotent, so the migration is safe to re-apply.
INSERT INTO backend_instance_epoch (id, last_ordinal)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
