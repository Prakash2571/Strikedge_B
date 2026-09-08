-- 005_broker_sessions.sql — the encrypted at-rest store for both brokers' daily
-- access tokens.
--
-- WHY POSTGRESQL, NOT MONGO
-- CalSpread kept the Zerodha and Dhan sessions in two Mongo collections. In
-- StrikeEdge PostgreSQL is the operational authority and MongoDB is only an async
-- reporting replica, so the live token a broker POST depends on lives here and is
-- NEVER projected to Mongo (see the outbox deny list). The ciphertext, IV and auth
-- tag never leave this table and are decrypted only inside
-- `src/brokerState/brokerSessions.ts`.
--
-- ONE ROW PER BROKER, STRICTLY SEPARATE
-- The primary key is the broker name, so Zerodha and Dhan occupy exactly one row
-- each and a write to one can never touch the other. Both may be present at once:
-- only one broker is ACTIVE, but keeping the standby broker's still-valid token
-- lets an operator switch back without a fresh login.
--
-- WHY THE METADATA IS IN THE CLEAR
-- `broker`, `credential_version`, `api_key_or_client_id` and `login_date` are the
-- GCM Additional Authenticated Data: they are stored unencrypted so they are
-- queryable and human-auditable, but they are bound into the auth tag, so
-- tampering with any of them makes the token fail to decrypt rather than decrypt
-- to a token bound to different facts.
--
-- EXPIRY SEMANTICS DIFFER BY BROKER
-- `login_date` is the IST YYYY-MM-DD the token was issued on; Zerodha tokens are
-- only honoured on their own login day. `expires_at` is Dhan's explicit expiry
-- (timestamptz) or NULL for "unknown, validate operationally". NULL never means
-- "never expires".

CREATE TABLE IF NOT EXISTS broker_sessions (
  -- Exactly 'zerodha' or 'dhan'. The primary key keeps the two rows separate.
  broker                 text        PRIMARY KEY,

  -- The AES-256-GCM ciphertext of the access token and its per-write IV and tag.
  -- Raw bytes; never returned through any API, never projected to Mongo.
  encrypted_access_token bytea       NOT NULL,
  encryption_iv          bytea       NOT NULL,
  encryption_auth_tag    bytea       NOT NULL,

  -- Bumped by a key/credential rotation; authenticated as AAD so a token cannot be
  -- read back under a different credential generation than it was sealed with.
  credential_version     integer     NOT NULL DEFAULT 1,

  -- Non-secret identity of the account the token belongs to (Zerodha user id or
  -- Dhan client id). Authenticated as AAD.
  broker_identity        text        NOT NULL DEFAULT '',

  -- The api_key (Zerodha) or client_id (Dhan) the token is bound to. Authenticated
  -- as AAD, and compared against KITE_API_KEY_EXPECTED / DHAN_CLIENT_ID_EXPECTED on
  -- acquisition so a token minted for a different app is refused.
  api_key_or_client_id   text        NOT NULL DEFAULT '',

  -- IST YYYY-MM-DD the token was issued on. Authenticated as AAD.
  login_date             text        NOT NULL,

  -- Dhan's explicit expiry, or NULL for "unknown — validate operationally".
  expires_at             timestamptz,

  -- When this process acquired and last validated the token.
  acquired_at            timestamptz NOT NULL DEFAULT now(),
  last_validated_at      timestamptz,

  -- SHA-256 of the provider URL the token came from, so a source swap is visible in
  -- diagnostics without storing the URL (which could carry a passcode in a
  -- misconfiguration).
  source_url_hash        text        NOT NULL DEFAULT '',

  -- 'active' while usable; 'invalidated' after a rejection. An invalidated row is
  -- kept (with a reason) rather than deleted, so a restart does not silently forget
  -- that a token was retired.
  status                 text        NOT NULL DEFAULT 'active',
  invalidated_at         timestamptz,
  invalidation_reason    text,

  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT broker_sessions_broker_valid CHECK (broker IN ('zerodha', 'dhan')),
  CONSTRAINT broker_sessions_status_valid CHECK (status IN ('active', 'invalidated')),
  CONSTRAINT broker_sessions_credential_version_positive CHECK (credential_version >= 1),
  CONSTRAINT broker_sessions_reason_bounded
    CHECK (invalidation_reason IS NULL OR length(invalidation_reason) <= 500)
);
