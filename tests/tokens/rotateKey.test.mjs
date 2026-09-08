/**
 * rotateBrokerTokenKey — key rotation inside one transaction.
 *
 * Proves: --dry-run writes nothing; a real rotation re-encrypts every session so it
 * decrypts under the NEW key and no longer under the old; the script prints no token
 * material.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — the harness throws at setup.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { createPgHarness, DATABASE_URL, TEST_KEY_HEX } from "./helpers.mjs";

const run = promisify(execFile);

const OLD_KEY = TEST_KEY_HEX;
const NEW_KEY = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const SECRET_TOKEN = "SUPER_SECRET_ACCESS_TOKEN_do_not_print";

let h;
let schema;
let crypto;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = OLD_KEY;
  h = await createPgHarness("rotate");
  schema = h.schema;
  const store = await import("../../dist/brokerState/brokerSessions.js");
  crypto = await import("../../dist/brokerState/tokenCrypto.js");
  await store.saveKiteSession({ access_token: SECRET_TOKEN, user_id: "Z", user_name: "", login_date: "2026-09-08", api_key: "k" });
  await store.saveDhanSession({
    access_token: SECRET_TOKEN + "_dhan",
    dhan_client_id: "DCL",
    dhan_client_name: "",
    dhan_client_ucc: "",
    given_power_of_attorney: false,
    expiry_time: null,
    login_date: "2026-09-08",
  });
  // Close the shared pool so the child rotation process is the only writer.
  await h.pool.closePg();
});
after(async () => {
  if (h) await h.cleanup();
});

function childEnv(extra) {
  return { ...process.env, PGOPTIONS: `-c search_path=${schema}`, DATABASE_URL, ...extra };
}

/** Read a broker row's sealed fields + AAD directly, and decrypt with `keyHex`. */
async function decryptWithKey(broker, keyHex) {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, options: `-c search_path=${schema}` });
  try {
    const { rows } = await pool.query(
      `SELECT encrypted_access_token, encryption_iv, encryption_auth_tag,
              credential_version, api_key_or_client_id, login_date
         FROM broker_sessions WHERE broker = $1`,
      [broker],
    );
    const r = rows[0];
    const key = crypto.decodeEncryptionKey(keyHex);
    return crypto.openToken(
      key,
      { ciphertext: r.encrypted_access_token, iv: r.encryption_iv, authTag: r.encryption_auth_tag },
      { broker, credentialVersion: r.credential_version, apiKeyOrClientId: r.api_key_or_client_id, loginDate: r.login_date },
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

test("--dry-run validates but writes nothing and prints no token material", async () => {
  const { stdout, stderr } = await run(
    "node",
    ["dist/scripts/rotateBrokerTokenKey.js", "--dry-run"],
    { env: childEnv({ BROKER_TOKEN_OLD_KEY: OLD_KEY, BROKER_TOKEN_NEW_KEY: NEW_KEY }) },
  );
  const out = stdout + stderr;
  assert.match(out, /Dry run OK/i);
  assert.equal(out.includes(SECRET_TOKEN), false, "dry run must not print token material");
  // Nothing changed: the OLD key still decrypts.
  assert.equal(await decryptWithKey("zerodha", OLD_KEY), SECRET_TOKEN);
});

test("a real rotation re-encrypts every session under the NEW key; the old key no longer decrypts", async () => {
  const { stdout, stderr } = await run(
    "node",
    ["dist/scripts/rotateBrokerTokenKey.js"],
    { env: childEnv({ BROKER_TOKEN_OLD_KEY: OLD_KEY, BROKER_TOKEN_NEW_KEY: NEW_KEY }) },
  );
  const out = stdout + stderr;
  assert.match(out, /Rotation complete: 2 session/i);
  assert.equal(out.includes(SECRET_TOKEN), false, "rotation must not print token material");

  // NEW key decrypts both sessions.
  assert.equal(await decryptWithKey("zerodha", NEW_KEY), SECRET_TOKEN);
  assert.equal(await decryptWithKey("dhan", NEW_KEY), SECRET_TOKEN + "_dhan");

  // OLD key no longer decrypts.
  await assert.rejects(() => decryptWithKey("zerodha", OLD_KEY), /decrypt|authenticate|key/i);
});

test("missing keys are rejected without touching the database", async () => {
  await assert.rejects(
    () => run("node", ["dist/scripts/rotateBrokerTokenKey.js"], { env: childEnv({}) }),
    (err) => {
      assert.match(String(err.stderr ?? err.stdout ?? err.message), /BROKER_TOKEN_OLD_KEY|command line/i);
      return true;
    },
  );
});
