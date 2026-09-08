/**
 * Broker session persistence — the ONLY place a broker token is encrypted, stored,
 * decrypted or read back.
 *
 * PORTING CONTRACT (INTERNAL_SEAMS.md, seam 5)
 * These functions keep CalSpread's signatures exactly — `loadDhanSession`,
 * `saveDhanSession`, `clearDhanSession`, `loadActiveBroker`, `saveActiveBroker`,
 * plus Zerodha equivalents — so `src/brokers/registry.ts` is ported by changing a
 * single import line from `../db.js` to `../brokerState/brokerSessions.js`. The
 * shapes returned (`IKiteSession`, `IDhanSession`, `{ broker, generation }`) are
 * the CalSpread shapes the ActiveBrokerManager already destructures.
 *
 * WHAT CHANGED UNDERNEATH
 * CalSpread stored these as plaintext Mongo documents. StrikeEdge stores the access
 * token AES-256-GCM-encrypted in PostgreSQL (`broker_sessions`) and the active
 * broker in `active_broker` with a durable, monotonic generation from a sequence.
 * The plaintext token exists only transiently in memory here and in the client that
 * receives it; it is never returned by an API and never projected to Mongo.
 *
 * FAIL LOUDLY, NEVER SILENTLY UNREADABLE
 * If a row exists but the key is missing or wrong, `loadDhanSession` /
 * `loadKiteSession` throw rather than returning null: a null would look like "no
 * session" and trigger a fresh acquisition, quietly discarding a token that is
 * actually fine and only misconfigured. Boot surfaces the throw.
 */

import { withClient, withTx, query } from "../pg/pool.js";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import {
  decodeEncryptionKey,
  openToken,
  sealToken,
  type SealedToken,
  type TokenAad,
} from "./tokenCrypto.js";

/* -------------------------------------------------------------------------- */
/*  CalSpread-compatible session shapes                                       */
/* -------------------------------------------------------------------------- */

/** Zerodha session — the CalSpread `IKiteSession` shape (minus the Mongo `_id`). */
export interface IKiteSession {
  access_token: string;
  user_id: string;
  user_name: string;
  login_date: string;
  updated_at: Date;
}

/** Dhan session — the CalSpread `IDhanSession` shape (minus the Mongo `_id`). */
export interface IDhanSession {
  access_token: string;
  dhan_client_id: string;
  dhan_client_name: string;
  dhan_client_ucc: string;
  given_power_of_attorney: boolean;
  expiry_time: number | null;
  login_at: Date;
  login_date: string;
  updated_at: Date;
}

/* -------------------------------------------------------------------------- */
/*  Key handling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the encryption key from the environment at call time (not module load),
 * so a test can set the env before the first store. Throws a typed, non-leaking
 * error when the key is absent/invalid.
 */
function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  return decodeEncryptionKey(env.BROKER_TOKEN_ENCRYPTION_KEY);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/*  Generic row read/write                                                    */
/* -------------------------------------------------------------------------- */

interface StoredRow {
  broker: string;
  encrypted_access_token: Buffer;
  encryption_iv: Buffer;
  encryption_auth_tag: Buffer;
  credential_version: number;
  broker_identity: string;
  api_key_or_client_id: string;
  login_date: string;
  expires_at: Date | null;
  status: string;
}

/**
 * The fields common to persisting either broker. `sourceUrl` is hashed, never
 * stored raw. `credentialVersion` defaults to 1 and is authenticated as AAD.
 */
export interface PersistSessionInput {
  broker: "zerodha" | "dhan";
  accessToken: string;
  brokerIdentity: string;
  apiKeyOrClientId: string;
  loginDate: string;
  /** Dhan explicit expiry (epoch ms) or null. Zerodha always null. */
  expiryTimeMs: number | null;
  sourceUrl: string;
  credentialVersion?: number;
}

/**
 * Encrypt and UPSERT one broker's row atomically. Writing one broker's row can
 * never touch the other's because the primary key is the broker name and this
 * statement names exactly one broker.
 */
async function persistSession(input: PersistSessionInput, client?: PoolClient): Promise<void> {
  const k = key();
  const credentialVersion = input.credentialVersion ?? 1;
  const aad: TokenAad = {
    broker: input.broker,
    credentialVersion,
    apiKeyOrClientId: input.apiKeyOrClientId,
    loginDate: input.loginDate,
  };
  const sealed = sealToken(k, input.accessToken, aad);
  const expiresAt = input.expiryTimeMs === null ? null : new Date(input.expiryTimeMs);
  const sourceHash = sha256Hex(input.sourceUrl);

  const sql = `
    INSERT INTO broker_sessions (
      broker, encrypted_access_token, encryption_iv, encryption_auth_tag,
      credential_version, broker_identity, api_key_or_client_id, login_date,
      expires_at, acquired_at, last_validated_at, source_url_hash, status,
      invalidated_at, invalidation_reason, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10, 'active', NULL, NULL, now())
    ON CONFLICT (broker) DO UPDATE SET
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      encryption_iv          = EXCLUDED.encryption_iv,
      encryption_auth_tag    = EXCLUDED.encryption_auth_tag,
      credential_version     = EXCLUDED.credential_version,
      broker_identity        = EXCLUDED.broker_identity,
      api_key_or_client_id   = EXCLUDED.api_key_or_client_id,
      login_date             = EXCLUDED.login_date,
      expires_at             = EXCLUDED.expires_at,
      acquired_at            = now(),
      last_validated_at      = now(),
      source_url_hash        = EXCLUDED.source_url_hash,
      status                 = 'active',
      invalidated_at         = NULL,
      invalidation_reason    = NULL,
      updated_at             = now()`;
  const params = [
    input.broker,
    sealed.ciphertext,
    sealed.iv,
    sealed.authTag,
    credentialVersion,
    input.brokerIdentity,
    input.apiKeyOrClientId,
    input.loginDate,
    expiresAt,
    sourceHash,
  ];
  if (client) {
    await client.query(sql, params);
  } else {
    await query(sql, params);
  }
}

/** Read one broker's ACTIVE row and decrypt it. Throws on a key/tamper failure. */
async function readActiveSession(broker: "zerodha" | "dhan"): Promise<
  | { row: StoredRow; accessToken: string; expiresAtMs: number | null }
  | null
> {
  const { rows } = await query<StoredRow>(
    `SELECT broker, encrypted_access_token, encryption_iv, encryption_auth_tag,
            credential_version, broker_identity, api_key_or_client_id, login_date,
            expires_at, status
       FROM broker_sessions
      WHERE broker = $1 AND status = 'active'`,
    [broker],
  );
  const row = rows[0];
  if (!row) return null;
  const sealed: SealedToken = {
    ciphertext: row.encrypted_access_token,
    iv: row.encryption_iv,
    authTag: row.encryption_auth_tag,
  };
  const aad: TokenAad = {
    broker: row.broker,
    credentialVersion: row.credential_version,
    apiKeyOrClientId: row.api_key_or_client_id,
    loginDate: row.login_date,
  };
  // Throws TokenCryptoError on a missing/wrong key or tampered row. Deliberately
  // NOT caught here: a stored-but-unreadable token must fail loudly.
  const accessToken = openToken(key(), sealed, aad);
  const expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : null;
  return { row, accessToken, expiresAtMs };
}

/** Mark one broker's row invalidated atomically, keeping the row for audit. */
async function invalidateSession(broker: "zerodha" | "dhan", reason: string): Promise<void> {
  await query(
    `UPDATE broker_sessions
        SET status = 'invalidated', invalidated_at = now(),
            invalidation_reason = $2, updated_at = now()
      WHERE broker = $1`,
    [broker, reason.slice(0, 500)],
  );
}

/* -------------------------------------------------------------------------- */
/*  Zerodha (Kite) session — CalSpread signatures                             */
/* -------------------------------------------------------------------------- */

/** Persist (upsert) the current Zerodha access token, encrypted. */
export async function saveKiteSession(data: {
  access_token: string;
  user_id: string;
  user_name: string;
  login_date: string;
  api_key?: string;
  source_url?: string;
}): Promise<void> {
  await persistSession({
    broker: "zerodha",
    accessToken: data.access_token,
    brokerIdentity: data.user_id || "",
    apiKeyOrClientId: data.api_key ?? "",
    loginDate: data.login_date,
    expiryTimeMs: null, // Zerodha tokens are day-scoped, not explicitly dated.
    sourceUrl: data.source_url ?? "",
  });
}

/** Load and decrypt the persisted Zerodha session, or null when none is stored. */
export async function loadKiteSession(): Promise<IKiteSession | null> {
  const found = await readActiveSession("zerodha");
  if (!found) return null;
  return {
    access_token: found.accessToken,
    user_id: found.row.broker_identity,
    user_name: "",
    login_date: found.row.login_date,
    updated_at: new Date(),
  };
}

/** Invalidate the persisted Zerodha session (auth failure / day roll). */
export async function clearKiteSession(reason = "cleared"): Promise<void> {
  await invalidateSession("zerodha", reason);
}

/* -------------------------------------------------------------------------- */
/*  Dhan session — CalSpread signatures                                       */
/* -------------------------------------------------------------------------- */

/** Persist (upsert) the current Dhan session, encrypted. */
export async function saveDhanSession(data: {
  access_token: string;
  dhan_client_id: string;
  dhan_client_name: string;
  dhan_client_ucc: string;
  given_power_of_attorney: boolean;
  expiry_time: number | null;
  login_date: string;
  source_url?: string;
}): Promise<void> {
  await persistSession({
    broker: "dhan",
    accessToken: data.access_token,
    // The client name / UCC / PoA are NOT authenticated as AAD (they are display
    // fields Dhan may vary), but the identity that the token is bound to — the
    // client id — is. They are stored here folded into broker_identity as a small
    // JSON blob so the CalSpread IDhanSession shape can be reconstructed on load.
    brokerIdentity: JSON.stringify({
      name: data.dhan_client_name,
      ucc: data.dhan_client_ucc,
      poa: data.given_power_of_attorney,
    }),
    apiKeyOrClientId: data.dhan_client_id,
    loginDate: data.login_date,
    expiryTimeMs: data.expiry_time,
    sourceUrl: data.source_url ?? "",
  });
}

/** Load and decrypt the persisted Dhan session, or null when none is stored. */
export async function loadDhanSession(): Promise<IDhanSession | null> {
  const found = await readActiveSession("dhan");
  if (!found) return null;
  let meta: { name?: string; ucc?: string; poa?: boolean } = {};
  try {
    meta = JSON.parse(found.row.broker_identity || "{}");
  } catch {
    meta = {};
  }
  return {
    access_token: found.accessToken,
    dhan_client_id: found.row.api_key_or_client_id,
    dhan_client_name: meta.name ?? "",
    dhan_client_ucc: meta.ucc ?? "",
    given_power_of_attorney: meta.poa === true,
    expiry_time: found.expiresAtMs,
    login_at: new Date(),
    login_date: found.row.login_date,
    updated_at: new Date(),
  };
}

/** Invalidate the persisted Dhan session (auth failure / expiry). */
export async function clearDhanSession(reason = "cleared"): Promise<void> {
  await invalidateSession("dhan", reason);
}

/* -------------------------------------------------------------------------- */
/*  Active broker — durable, monotonic generation                             */
/* -------------------------------------------------------------------------- */

/**
 * Persist a broker selection AND advance the generation atomically, returning the
 * NEW generation.
 *
 * The generation comes from `active_broker_generation_seq`, so two concurrent
 * switches cannot land on the same number and the value is strictly increasing and
 * never reused across restarts. `UPDATE ... RETURNING` (or the INSERT branch on a
 * fresh deployment) makes the read-back authoritative — the caller adopts exactly
 * what was stored, not its own guess.
 */
export async function saveActiveBroker(
  broker: string,
  selectedBy: string,
  opts: { reason?: string; tradingDay?: string } = {},
): Promise<{ generation: number } | null> {
  if (broker !== "zerodha" && broker !== "dhan") {
    throw new Error(`saveActiveBroker: invalid broker "${broker}"`);
  }
  return withTx(async (client) => {
    // Consume EXACTLY ONE sequence value via a CTE, then reference it in both the
    // INSERT and the ON CONFLICT UPDATE. Referencing `nextval(...)` directly in both
    // the VALUES clause and the UPDATE clause would consume TWO values on a conflict
    // (PostgreSQL evaluates the VALUES expression even when the row already exists),
    // leaving gaps. A single CTE value keeps the generation strictly consecutive
    // while remaining monotonic and never-repeating.
    const { rows } = await client.query<{ generation: string | number }>(
      `WITH g AS (SELECT nextval('active_broker_generation_seq') AS gen)
       INSERT INTO active_broker (id, broker, generation, selected_at, selected_by, reason, trading_day)
       SELECT 'current', $1, g.gen, now(), $2, $3, $4 FROM g
       ON CONFLICT (id) DO UPDATE SET
         broker      = EXCLUDED.broker,
         generation  = EXCLUDED.generation,
         selected_at = now(),
         selected_by = EXCLUDED.selected_by,
         reason      = EXCLUDED.reason,
         trading_day = EXCLUDED.trading_day
       RETURNING generation`,
      [broker, selectedBy.slice(0, 200), opts.reason ?? null, opts.tradingDay ?? ""],
    );
    const g = rows[0]?.generation;
    const generation = typeof g === "string" ? Number(g) : g;
    return typeof generation === "number" && Number.isFinite(generation) ? { generation } : null;
  });
}

/** The persisted broker selection and its generation, or null when unset. */
export async function loadActiveBroker(): Promise<{ broker: string; generation: number } | null> {
  const { rows } = await query<{ broker: string; generation: string | number }>(
    `SELECT broker, generation FROM active_broker WHERE id = 'current'`,
  );
  const row = rows[0];
  if (!row?.broker) return null;
  const generation = typeof row.generation === "string" ? Number(row.generation) : row.generation;
  return {
    broker: row.broker,
    generation: Number.isFinite(generation) && generation > 0 ? generation : 1,
  };
}

/* -------------------------------------------------------------------------- */
/*  Shared internals exported for the token service and rotation script       */
/* -------------------------------------------------------------------------- */

export const __internal = {
  persistSession,
  readActiveSession,
  invalidateSession,
  sha256Hex,
  withClient,
};
