/**
 * Protected runtime + export status endpoints.
 *
 *   GET /api/runtime/status   what the operator needs to trust the process: per
 *                             broker token/feed health, PostgreSQL + migration
 *                             readiness, recovery/residual state, and WHY live
 *                             entry is blocked.
 *   GET /api/export/status    the Mongo async-replica outbox backlog health.
 *
 * DEPENDENCY DIRECTION
 * This module imports NOTHING from the engine, the token service or the projector.
 * Those are owned by other agents and may not exist yet. Instead it defines narrow
 * provider interfaces and receives an implementation object from src/index.ts,
 * which wires the real subsystems in. That keeps this file compilable in isolation
 * and keeps the seam explicit.
 *
 * NO SECRETS
 * No provider here may return an access token, an encrypted token, the site
 * passcode or any key material. The shapes below are deliberately restricted to
 * states, counts, ages, timestamps and redacted error strings.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { sendApiError } from "../access/middleware.js";

/** Per-broker token acquisition state. */
export type TokenState = "waiting" | "polling" | "ready" | "invalid" | "configuration_error";

export type BrokerId = "zerodha" | "dhan";

/** Per-broker runtime status. NEVER includes a token. */
export interface BrokerRuntimeStatus {
  broker: BrokerId;
  token_state: TokenState;
  /** Current IST trading day the token scheduler is working against, e.g. "2026-09-08". */
  ist_day: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  /** Bounded, redacted error string — never a token, SQL or stack. */
  last_error: string | null;
  feed_connected: boolean;
  wanted_token_count: number;
  subscribed_token_count: number;
  /** Age in ms of the last authoritative depth update, or null if none yet. */
  last_depth_age_ms: number | null;
  reconnect_count: number;
}

export interface LiveEntryStatus {
  /** True when the engine will refuse new live ENTRIES (exits are never blocked). */
  blocked: boolean;
  /** Human-readable reasons for the block; empty when not blocked. */
  reasons: string[];
}

export interface RuntimeStatusSnapshot {
  brokers: BrokerRuntimeStatus[];
  active_broker: BrokerId | null;
  pg_ready: boolean;
  /** e.g. { applied: number, pending: number } — never SQL. */
  migration_state: { applied: number; pending: number };
  recovery_ready: boolean;
  live_entry: LiveEntryStatus;
  /** True when a crash-recovery pass is still outstanding. */
  recovery_pending: boolean;
  /** True when residual (partial-entry) exposure exists that needs flattening. */
  residual_exposure: boolean;
}

/** Provider for /api/runtime/status. Implemented in src/index.ts. */
export interface RuntimeStatusProvider {
  getRuntimeStatus(): Promise<RuntimeStatusSnapshot> | RuntimeStatusSnapshot;
}

/** The Mongo async-replica outbox backlog health. NEVER includes payloads. */
export interface ExportStatusSnapshot {
  /** Whether the projector is configured to run at all (URI present + export enabled). */
  enabled: boolean;
  /** Whether the projector currently holds a live Mongo connection. */
  connected: boolean;
  /** Rows in the outbox not yet acknowledged by Mongo. */
  backlog_count: number;
  /** Age in ms of the oldest pending row, or null when the backlog is empty. */
  oldest_pending_age_ms: number | null;
  last_success_at: string | null;
  /** Bounded, redacted last error, or null. */
  last_error: string | null;
  dead_letter_count: number;
}

/** Provider for /api/export/status. Implemented in src/index.ts. */
export interface ExportStatusProvider {
  getExportStatus(): Promise<ExportStatusSnapshot> | ExportStatusSnapshot;
}

export interface RuntimeStatusRouteDeps {
  /** requireOperator — every route here is operator-only. */
  requireOperator: RequestHandler;
  runtime: RuntimeStatusProvider;
  exportStatus: ExportStatusProvider;
}

export function registerRuntimeStatusRoutes(app: Express, deps: RuntimeStatusRouteDeps): void {
  const { requireOperator, runtime, exportStatus } = deps;

  app.get("/api/runtime/status", requireOperator, async (_req: Request, res: Response) => {
    try {
      const snapshot = await runtime.getRuntimeStatus();
      res.status(200).json(snapshot);
    } catch {
      sendApiError(res, 503, "runtime_status_unavailable", "Runtime status is temporarily unavailable.");
    }
  });

  app.get("/api/export/status", requireOperator, async (_req: Request, res: Response) => {
    try {
      const snapshot = await exportStatus.getExportStatus();
      res.status(200).json(snapshot);
    } catch {
      sendApiError(res, 503, "export_status_unavailable", "Export status is temporarily unavailable.");
    }
  });
}
