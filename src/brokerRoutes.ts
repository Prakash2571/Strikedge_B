/**
 * Protected broker-selection surface, mounted under /api/broker.
 *
 *   GET  /api/broker/status          the active broker + redacted session/health.
 *   GET  /api/broker/switch-blockers  why a switch would be refused, without trying.
 *   POST /api/broker/select           switch the active broker (body {"broker":…}).
 *
 * Exactly one broker (zerodha | dhan) is active at a time. All three routes require
 * a fully authenticated site operator (requireOperator). POST is additionally
 * subject to the CSRF + Origin discipline requireOperator enforces on mutations.
 *
 * DEPENDENCY DIRECTION
 * The real ActiveBrokerManager lives in another agent's module (src/brokers/registry.ts)
 * and is injected by src/index.ts through the narrow ActiveBrokerProvider interface
 * below, so this file compiles in isolation and never reaches into broker internals.
 *
 * NO SECRETS
 * No route here returns a raw access token, an encrypted token, the site passcode
 * or any encryption metadata. Only redacted session descriptors, health states,
 * the active broker id and the switch-blocker list cross this boundary. A refused
 * switch returns the EXACT blocker list so an operator sees every problem at once.
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { getOperatorRole, sendApiError } from "./access/middleware.js";

export type BrokerId = "zerodha" | "dhan";

export function parseBrokerId(raw: unknown): BrokerId | null {
  return raw === "zerodha" || raw === "dhan" ? raw : null;
}

/** A redacted broker session descriptor. NEVER a token or key material. */
export interface RedactedBrokerSession {
  broker: BrokerId;
  connected: boolean;
  /**
   * Lifecycle state of this broker's session, derived (never a raw token):
   *   waiting  — not authenticated yet
   *   expired  — authenticated but the token is past its expiry
   *   ready    — authenticated, unexpired AND the active broker
   *   standby  — authenticated, unexpired but not the active broker
   */
  state: "waiting" | "expired" | "ready" | "standby";
  /**
   * Opaque account label if the broker exposes one; never a credential.
   *
   * REQUIRED-NULLABLE, not optional: `sessionFor` (via projectBrokerSession) ALWAYS
   * populates all three of account_label/established_at/expires_at — as a value or as
   * an explicit `null`. Declaring them `string | null` (rather than `?`) matches that
   * reality and keeps the contract schema closed. The wire bytes are unchanged.
   */
  account_label: string | null;
  established_at: string | null;
  expires_at: string | null;
}

/** A redacted broker health descriptor. */
export interface BrokerHealth {
  broker: BrokerId;
  authenticated: boolean;
  data_ready: boolean;
  trading_ready: boolean;
  problems: string[];
}

export interface SwitchResult {
  ok: boolean;
  broker: BrokerId;
  /** Populated (and the reason for ok:false) when a switch is refused. */
  blockers: string[];
}

/**
 * The narrow provider src/index.ts supplies (backed by the real ActiveBrokerManager).
 * Every method is redacted-by-contract — no token, encrypted token or key metadata.
 */
export interface ActiveBrokerProvider {
  activeBroker(): BrokerId;
  /** Monotonic generation, bumped on every switch. */
  generation(): number;
  sessionFor(broker: BrokerId): RedactedBrokerSession;
  healthFor(broker: BrokerId): BrokerHealth;
  /** Why switching to `broker` would be refused right now. */
  switchBlockers(broker: BrokerId): Promise<string[]> | string[];
  /** Perform the switch; returns ok:false + blockers when exposure/in-flight work exists. */
  selectBroker(broker: BrokerId, selectedBy: string): Promise<SwitchResult> | SwitchResult;
}

export interface BrokerRouteDeps {
  requireOperator: RequestHandler;
  manager: ActiveBrokerProvider;
  /** Optional hook so index.ts can push a fresh Box SSE snapshot after a switch. */
  onBrokerChanged?: (broker: BrokerId) => void;
}

export function registerBrokerRoutes(app: Express, deps: BrokerRouteDeps): void {
  const { requireOperator, manager } = deps;

  /** The active broker plus redacted session + health for both brokers. */
  app.get("/api/broker/status", requireOperator, (_req: Request, res: Response) => {
    const active = manager.activeBroker();
    res.status(200).json({
      active_broker: active,
      generation: manager.generation(),
      brokers: (["zerodha", "dhan"] as BrokerId[]).map((b) => ({
        broker: b,
        session: manager.sessionFor(b),
        health: manager.healthFor(b),
      })),
    });
  });

  /** Why a switch would be refused, without attempting it. */
  app.get("/api/broker/switch-blockers", requireOperator, async (req: Request, res: Response) => {
    try {
      const target = parseBrokerId(req.query.broker) ?? manager.activeBroker();
      res.status(200).json({ broker: target, blockers: await manager.switchBlockers(target) });
    } catch {
      sendApiError(res, 503, "broker_status_unavailable", "Broker status is temporarily unavailable.");
    }
  });

  /**
   * Switch the active broker. Refuses with 409 and the FULL blocker list when Box
   * exposure or in-flight work exists — an operator clearing three problems should
   * see three, not discover them one at a time.
   */
  app.post("/api/broker/select", requireOperator, async (req: Request, res: Response) => {
    try {
      const broker = parseBrokerId((req.body as { broker?: unknown } | undefined)?.broker);
      if (!broker) {
        sendApiError(res, 400, "bad_broker", 'broker must be "zerodha" or "dhan".');
        return;
      }
      const selectedBy = getOperatorRole(req) ?? "operator";
      const result = await manager.selectBroker(broker, selectedBy);
      if (!result.ok) {
        res.status(409).json({
          error: "Cannot change broker while Box exposure or in-flight work exists.",
          code: "switch_refused",
          blockers: result.blockers,
          active_broker: manager.activeBroker(),
        });
        return;
      }
      deps.onBrokerChanged?.(result.broker);
      res.status(200).json({
        ok: true,
        active_broker: manager.activeBroker(),
        generation: manager.generation(),
      });
    } catch {
      sendApiError(res, 503, "broker_switch_unavailable", "Broker switch is temporarily unavailable.");
    }
  });
}
