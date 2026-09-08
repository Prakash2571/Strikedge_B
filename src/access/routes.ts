/**
 * The site-passcode HTTP surface, mounted under /api/access.
 *
 *   POST /api/access/verify   public, rate-limited. Checks the passcode and, on
 *                             success, mints a session + CSRF token and sets the
 *                             cookies. This is the ONLY public mutating route.
 *   GET  /api/access/status   returns whether the caller has a live session and,
 *                             if so, the CSRF token for subsequent mutating calls.
 *   POST /api/access/logout   revokes the session row and clears the cookies.
 *
 * ARMS NOTHING
 * A successful verify grants the operator the FULL Box CONTROL surface (role
 * "full"), but it does not — and must not — arm live trading or enable real
 * orders. The BOX_EXECUTION_MODE / BOX_LIVE_TRADING_ENABLED / per-broker gates and
 * the runtime arming controls are entirely independent and are never touched here.
 */

import type { Express, Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { clearSessionCookies, csrfCookieName, readCookie, setSessionCookies } from "./cookies.js";
import { CSRF_HEADER, csrfMatches, originAllowed } from "./csrf.js";
import { sendApiError } from "./middleware.js";
import type { AccessSessionConfig } from "./sessionStore.js";
import {
  isSecretConfigured,
  mintSession,
  revokeSession,
  validateSession,
  verifyPasscode,
} from "./sessionStore.js";

export interface AccessRouteDeps {
  config: AppConfig;
  session: AccessSessionConfig;
  /** The verify rate-limit middleware (10 / 5 min / IP). */
  verifyRateLimit: import("express").RequestHandler;
}

/** Read the client IP the way the ported rate limiter does (nginx X-Forwarded-For). */
function clientIp(req: Request): string | undefined {
  const fwd = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return fwd || req.socket.remoteAddress || undefined;
}

export function registerAccessRoutes(app: Express, deps: AccessRouteDeps): void {
  const { config, session } = deps;
  const csrfName = csrfCookieName(config);
  const ttlSeconds = Math.floor(session.ttlHours * 60 * 60);

  /**
   * POST /api/access/verify — check the passcode.
   *
   * Generic failure: a wrong passcode and an UNSET secret produce the exact same
   * 401 body, so the response never distinguishes "wrong" from "not configured".
   * verifyPasscode fails closed when the secret is unset, so this route can never
   * mint a session without a real, matching passcode.
   */
  app.post("/api/access/verify", deps.verifyRateLimit, async (req: Request, res: Response) => {
    try {
      const presented =
        typeof (req.body as { passcode?: unknown } | undefined)?.passcode === "string"
          ? ((req.body as { passcode: string }).passcode)
          : undefined;

      if (!verifyPasscode(session, presented)) {
        // Identical body whether the passcode was wrong or the secret is unset.
        sendApiError(res, 401, "invalid_passcode", "Invalid passcode.");
        return;
      }

      const minted = await mintSession(session, {
        ip: clientIp(req),
        userAgent: req.header("user-agent") ?? undefined,
        role: "full",
      });

      setSessionCookies(res, config, {
        sessionToken: minted.sessionToken,
        csrfToken: minted.csrfToken,
        csrfCookieName: csrfName,
        maxAgeSeconds: ttlSeconds,
      });

      // The CSRF token is also returned in the body so an SPA can capture it
      // without reading the cookie. It grants nothing on its own — a mutating
      // request still needs the HttpOnly session cookie AND a matching Origin.
      res.status(200).json({
        authenticated: true,
        role: minted.role,
        csrf_token: minted.csrfToken,
        expires_at: minted.expiresAt.toISOString(),
      });
    } catch {
      // Never leak the cause of a mint/storage failure.
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });

  /**
   * GET /api/access/status — is there a live session?
   *
   * Public (no requireOperator) so the passcode page can ask "am I already in?"
   * without a 401 loop. Returns the CSRF token for a live session so the SPA can
   * recover it after a reload; returns `authenticated:false` otherwise. Never
   * reveals whether the secret is configured.
   */
  app.get("/api/access/status", async (req: Request, res: Response) => {
    try {
      const token = readCookie(req, config.sessionCookieName);
      const live = await validateSession(token);
      if (!live) {
        res.status(200).json({ authenticated: false });
        return;
      }
      // Echo the CSRF token from the cookie if present (it is JS-readable anyway),
      // so a reloaded SPA can repopulate its header source. We never store or
      // return the raw token from the DB — only the cookie can supply it.
      const csrfFromCookie = readCookie(req, csrfName);
      res.status(200).json({
        authenticated: true,
        role: live.role,
        expires_at: live.expiresAt.toISOString(),
        ...(csrfFromCookie && csrfMatches(csrfFromCookie, live.csrfTokenHash)
          ? { csrf_token: csrfFromCookie }
          : {}),
      });
    } catch {
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });

  /**
   * POST /api/access/logout — revoke the session and clear the cookies.
   *
   * A logout is a mutating request, so it is protected by the same Origin + CSRF
   * discipline as any other mutation (checked inline here because the route is not
   * behind requireOperator — an already-expired session must still be able to clear
   * its cookies). We validate the session, enforce Origin + CSRF, then revoke.
   */
  app.post("/api/access/logout", async (req: Request, res: Response) => {
    try {
      const token = readCookie(req, config.sessionCookieName);
      const live = await validateSession(token);

      if (live) {
        if (!originAllowed(req.headers.origin, config.csrfAllowedOrigin)) {
          sendApiError(res, 403, "bad_origin", "Request origin is not allowed.");
          return;
        }
        const presented = req.header(CSRF_HEADER) ?? readCookie(req, csrfName);
        if (!csrfMatches(presented, live.csrfTokenHash)) {
          sendApiError(res, 403, "csrf_failed", "Invalid or missing CSRF token.");
          return;
        }
        await revokeSession(token);
      }

      // Always clear the cookies, even if the session was already dead, so the
      // browser stops presenting a revoked/expired credential.
      clearSessionCookies(res, config, csrfName);
      res.status(200).json({ authenticated: false });
    } catch {
      sendApiError(res, 503, "access_unavailable", "Access is temporarily unavailable.");
    }
  });
}
