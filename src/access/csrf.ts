/**
 * CSRF token minting and constant-time verification, plus the Origin check.
 *
 * MODEL
 * A CSRF token is minted alongside the session (see sessionStore.mintSession) and
 * only its sha256 is stored, bound to the session row. The raw token is delivered
 * to the browser in a NON-HttpOnly cookie and echoed by /api/access/status, so the
 * SPA can send it back in a request header on every mutating request. The server
 * recomputes sha256 over the header value and compares it — in constant time —
 * against the digest bound to the authenticated session.
 *
 * WHY THIS DEFEATS CSRF
 * A cross-site attacker can cause the browser to send our cookies, but the
 * same-origin policy stops their page from READING the non-HttpOnly CSRF cookie,
 * so they cannot populate the required header with the matching value. The Origin
 * check is a second, independent guard for the same class of attack.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The request header the SPA must send the CSRF token in. */
export const CSRF_HEADER = "x-csrf-token";

/** HTTP methods that mutate state and therefore require CSRF + Origin checks. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/** A fresh 256-bit CSRF token, base64url so it is header/cookie/JSON safe. */
export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 hex of a token — the only representation stored/compared server-side. */
export function hashCsrfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time equality of the presented CSRF token against the session-bound
 * digest.
 *
 * The presented token is hashed to a fixed-width digest first, so timingSafeEqual
 * always compares two equal-length (32-byte) buffers and never throws on a length
 * mismatch — a mismatch there would itself leak length via the throw path.
 */
export function csrfMatches(presentedToken: string | undefined, boundHash: string): boolean {
  if (!presentedToken) return false;
  const presentedHash = hashCsrfToken(presentedToken);
  const a = Buffer.from(presentedHash, "hex");
  const b = Buffer.from(boundHash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Validate the Origin header of a mutating request against the configured
 * allowed origin.
 *
 * A missing Origin is REJECTED for mutating requests: same-origin fetches from a
 * modern browser send Origin on state-changing methods, and the safe default for
 * an absent value is to refuse rather than to wave it through. The comparison is a
 * normalised exact-origin match (scheme + host + port), never a prefix or wildcard.
 */
export function originAllowed(origin: string | undefined, allowedOrigin: string): boolean {
  if (!origin) return false;
  return normalizeOrigin(origin) === normalizeOrigin(allowedOrigin);
}

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
