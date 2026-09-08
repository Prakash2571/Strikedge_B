/**
 * Projection diagnostics snapshot — the read model behind `GET /api/export/status`.
 *
 * WHAT THIS IS FOR
 * An operator (and the broker-switch blocker report) needs to answer "is anything
 * still waiting to be projected, and is anything stuck?" without touching Mongo or
 * reading the projector's internals. This module exposes a single async function
 * that computes that snapshot from PostgreSQL — the authoritative store — plus the
 * projector's in-memory runtime facts (connected? last success? last error?).
 *
 * WHY IT IS A PLAIN FUNCTION AND A TYPE
 * `src/runtime/statusRoutes.ts` (another agent) consumes this via an injected
 * provider. So this module MUST NOT import or reach into the HTTP layer: it exports
 * `getExportStatus(...)` and `ExportStatusSnapshot`, and the runtime wires them.
 *
 * NO SECRETS
 * The snapshot carries counts, ages, timestamps and a BOUNDED last error. It never
 * carries the Mongo URI, a payload, a broker token, a passcode or a credential. The
 * backlog query selects only ids and timestamps, never `payload`.
 */

import type { Pool } from "pg";

/** The immutable, secret-free shape returned to the status endpoint. */
export interface ExportStatusSnapshot {
  /** Whether the projector is configured to run at all (URI present + export enabled). */
  enabled: boolean;
  /** Whether the projector currently holds a live Mongo connection. */
  connected: boolean;
  /** Unpublished, non-dead-lettered rows still waiting to be drained. */
  backlog: number;
  /** Age in ms of the oldest pending row (by created_at), or null if the backlog is empty. */
  oldestPendingAgeMs: number | null;
  /** When the projector last published at least one row, ISO-8601, or null. */
  lastSuccessAt: string | null;
  /** The last bounded (<=500 char, secret-free) delivery error, or null. */
  lastError: string | null;
  /** Rows that exhausted their attempt budget and were dead-lettered. */
  deadLettered: number;
  /** Total rows ever published (published_at IS NOT NULL). */
  publishedTotal: number;
  /**
   * Cheap histogram of attempt counts across still-pending rows, keyed by attempt
   * count as a string. Bounded by GROUP BY over the pending partial index, so it is
   * proportional to the backlog rather than to history.
   */
  attemptsHistogram: Record<string, number>;
}

/**
 * The projector's in-memory runtime facts. The projector owns and updates this
 * singleton; the status provider reads it. Kept here (not in the projector) so the
 * status module has no import dependency on the projector's loop internals.
 */
export interface ProjectorRuntimeState {
  connected: boolean;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

const runtimeState: ProjectorRuntimeState = {
  connected: false,
  lastSuccessAt: null,
  lastError: null,
};

/** Replace the whole runtime state (used by the projector on each iteration). */
export function setProjectorRuntimeState(patch: Partial<ProjectorRuntimeState>): void {
  if (patch.connected !== undefined) runtimeState.connected = patch.connected;
  if (patch.lastSuccessAt !== undefined) runtimeState.lastSuccessAt = patch.lastSuccessAt;
  if (patch.lastError !== undefined) runtimeState.lastError = patch.lastError;
}

/** Read the current runtime state (a copy, so callers cannot mutate it). */
export function getProjectorRuntimeState(): ProjectorRuntimeState {
  return { ...runtimeState };
}

/** Reset runtime state — used by tests to isolate files. */
export function resetProjectorRuntimeState(): void {
  runtimeState.connected = false;
  runtimeState.lastSuccessAt = null;
  runtimeState.lastError = null;
}

interface BacklogRow {
  backlog: string | number;
  dead_lettered: string | number;
  published_total: string | number;
  oldest_pending_ms: string | number | null;
}

/**
 * Compute the snapshot. `enabled` is supplied by the caller (it is a config fact,
 * not a database fact), and the runtime facts come from the projector's singleton.
 * Everything else is read from PostgreSQL in two cheap aggregate queries.
 *
 * NOTE: `INT8`/`NUMERIC` are parsed to JS numbers process-wide (see `src/pg/pool.ts`),
 * so `count(*)` comes back as a number here; the union type is defensive only.
 */
export async function getExportStatus(
  pool: Pool,
  enabled: boolean,
): Promise<ExportStatusSnapshot> {
  const rt = getProjectorRuntimeState();

  const { rows } = await pool.query<BacklogRow>(
    `SELECT
       count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)                 AS backlog,
       count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)                                       AS dead_lettered,
       count(*) FILTER (WHERE published_at IS NOT NULL)                                           AS published_total,
       (EXTRACT(EPOCH FROM (clock_timestamp() - min(created_at) FILTER (
           WHERE published_at IS NULL AND dead_lettered_at IS NULL))) * 1000)::bigint             AS oldest_pending_ms
     FROM mongo_outbox`,
  );

  const row = rows[0];
  const backlog = toNum(row?.backlog);
  const deadLettered = toNum(row?.dead_lettered);
  const publishedTotal = toNum(row?.published_total);
  const oldestPendingAgeMs = row?.oldest_pending_ms == null ? null : Math.max(0, toNum(row.oldest_pending_ms));

  const { rows: histoRows } = await pool.query<{ attempts: number; n: string | number }>(
    `SELECT attempts, count(*) AS n
       FROM mongo_outbox
      WHERE published_at IS NULL AND dead_lettered_at IS NULL
      GROUP BY attempts
      ORDER BY attempts`,
  );
  const attemptsHistogram: Record<string, number> = {};
  for (const h of histoRows) attemptsHistogram[String(h.attempts)] = toNum(h.n);

  return {
    enabled,
    connected: enabled && rt.connected,
    backlog,
    oldestPendingAgeMs,
    lastSuccessAt: rt.lastSuccessAt ? rt.lastSuccessAt.toISOString() : null,
    lastError: rt.lastError,
    deadLettered,
    publishedTotal,
    attemptsHistogram,
  };
}

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
