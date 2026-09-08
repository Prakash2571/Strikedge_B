-- 007_access_sessions.sql — the site-passcode session store.
--
-- WHAT THIS TABLE IS
-- StrikeEdge is gated by a single site passcode. A successful passcode check
-- mints a high-entropy (256-bit) random session token, delivered to the browser
-- in an HttpOnly cookie, and a matching CSRF token. This table is the
-- server-side authority that says "this cookie corresponds to a live session".
--
-- WHAT IS NEVER STORED HERE
--  - the raw session token (only its sha256 — see below)
--  - the raw CSRF token (only its sha256)
--  - the site passcode (never persisted anywhere, ever)
--  - the raw client IP or user agent (only a salted-per-column sha256 hash, kept
--    for coarse abuse forensics, never to be reversed)
--
-- WHY sha256 AND NOT A PASSWORD HASH (bcrypt/argon2)
-- The session token is 256 bits of CSPRNG output, not a human-chosen secret. It
-- has no low-entropy structure to brute force, so a slow password hash buys
-- nothing and would only add latency to every authenticated request. sha256 is
-- used purely as a fast, fixed-width LOOKUP INDEX over an already-unguessable
-- value. The same reasoning applies to the CSRF token.
--
-- SESSION ROLE
-- The single site passcode grants the operator FULL Box controls, so `role` is
-- 'full' for every row minted here. The column keeps CalSpread's two-role shape
-- ('full' | 'trade') so `src/box/routes.ts` ports with a one-line import change;
-- 'trade' is simply never issued by the passcode gate. Entering the passcode
-- arms nothing — live trading stays behind its independent deployment gates.

CREATE TABLE IF NOT EXISTS access_sessions (
  -- sha256(session token) hex. Primary key so a lookup is a single index probe.
  -- The raw token exists only in the browser cookie and in transit; the server
  -- keeps this digest and nothing else.
  token_hash      text        PRIMARY KEY,

  -- sha256(csrf token) hex. The raw CSRF token is readable by JS (a non-HttpOnly
  -- cookie / the /api/access/status response) so the SPA can echo it in a header
  -- on mutating requests; only its digest is bound to the session here.
  csrf_token_hash text        NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Hard expiry. A session is invalid at and after this instant regardless of
  -- activity; there is no sliding renewal, so a stolen cookie has a bounded life.
  expires_at      timestamptz NOT NULL,

  -- Advanced on each authenticated use, for observability only. Never extends
  -- `expires_at`.
  last_seen_at    timestamptz NOT NULL DEFAULT now(),

  -- Salted sha256 of the client IP / user agent. Coarse forensic breadcrumbs;
  -- deliberately not reversible and never surfaced by any endpoint.
  ip_hash         text,
  user_agent_hash text,

  -- Set by logout (and by an admin revoke path). A revoked row is treated as
  -- absent on use but kept until the expiry sweep removes it, so a replay of the
  -- revoked cookie sees an explicit revocation rather than a silent miss.
  revoked_at      timestamptz,

  -- 'full' | 'trade'. Only 'full' is ever minted by the passcode gate.
  role            text        NOT NULL DEFAULT 'full'
    CONSTRAINT access_sessions_role_check CHECK (role IN ('full', 'trade'))
);

-- Expiry sweeps and the "is this session still live?" predicate both filter on
-- expires_at, so an index on it keeps the periodic bounded delete and the
-- validation lookup cheap even as dead rows accumulate between sweeps.
CREATE INDEX IF NOT EXISTS access_sessions_expires_at_idx
  ON access_sessions (expires_at);
