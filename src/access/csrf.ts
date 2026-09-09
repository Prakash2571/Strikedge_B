/**
 * CSRF token minting and constant-time verification, plus the Origin check.
 *
 * MODEL
 * A CSRF token is minted alongside the session (see sessionStore.mintSession) and
 * only its sha256 is stored, bound to the session row. The raw token is delivered
 * to the browser in a NON-HttpOnly cookie whose ONLY purpose is to let the SPA
 * recover the token after a page reload; the SPA echoes that value back in the
 * `x-csrf-token` request HEADER on every mutating request. The server recomputes
 * sha256 over the HEADER value and compares it — in constant time — against the
 * digest bound to the authenticated session.
 *
 * THE HEADER IS THE ONLY PROOF — THE COOKIE IS NEVER ACCEPTED AS A SUBSTITUTE
 * The readable CSRF cookie is a convenience for the SPA, not a credential. The
 * server verifies the token from the HEADER and NOTHING ELSE. Accepting the cookie
 * as a fallback would silently defeat the whole scheme: a cross-site form POST
 * causes the browser to attach our cookies automatically, so a cookie-as-header
 * fallback would let an attacker's page satisfy the CSRF check without ever reading
 * our cookie. Requiring the value in a header the attacker cannot set (they cannot
 * READ the cookie under the same-origin policy, so they cannot populate the header)
 * is exactly what stops the cross-site POST.
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

/**
 * Normalise a presented CSRF header value into either a non-empty token or
 * `undefined`. A missing header, or a present-but-empty/whitespace-only header,
 * both resolve to `undefined` so they are rejected identically by `csrfMatches`.
 * The header value must never be read from the cookie — see the module header.
 */
export function normalizeCsrfHeader(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
