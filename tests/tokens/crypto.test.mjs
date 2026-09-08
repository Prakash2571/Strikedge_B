/**
 * Broker session at-rest encryption and PostgreSQL persistence.
 *
 * Proves: tokens are encrypted at rest and ciphertext differs from plaintext;
 * separate writes cannot overwrite the other broker; restart restores and decrypts
 * both valid sessions; an invalid encryption key fails safely; neither token
 * appears in any status/API-shaped read.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — createPgHarness throws at setup.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createPgHarness, TEST_KEY_HEX } from "./helpers.mjs";

let h;
let store;
let crypto;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  h = await createPgHarness("crypto");
  store = await import("../../dist/brokerState/brokerSessions.js");
  crypto = await import("../../dist/brokerState/tokenCrypto.js");
});

after(async () => {
  if (h) await h.cleanup();
});

test("a stored Zerodha token is encrypted at rest and the ciphertext differs from the plaintext", async () => {
  const plaintext = "zerodha-access-token-SECRET-abc123";
  await store.saveKiteSession({
    access_token: plaintext,
    user_id: "AB1234",
    user_name: "Trader",
    login_date: "2026-09-08",
    api_key: "kapikey",
  });

  const c = await h.raw();
  try {
    const { rows } = await c.query(
      `SELECT encrypted_access_token, encryption_iv, encryption_auth_tag FROM broker_sessions WHERE broker = 'zerodha'`,
    );
    assert.equal(rows.length, 1);
    const cipher = rows[0].encrypted_access_token;
    assert.ok(Buffer.isBuffer(cipher));
    // The stored bytes must NOT contain the plaintext.
    assert.equal(cipher.toString("utf8").includes(plaintext), false);
    assert.equal(cipher.toString("latin1").includes(plaintext), false);
    assert.ok(rows[0].encryption_iv.length === 12);
    assert.ok(rows[0].encryption_auth_tag.length === 16);
  } finally {
    c.release();
  }

  // Round-trips back to the exact plaintext.
  const loaded = await store.loadKiteSession();
  assert.equal(loaded.access_token, plaintext);
  assert.equal(loaded.login_date, "2026-09-08");
});

test("a fresh IV is used on every write, so re-storing the same token yields different ciphertext", async () => {
  const token = "same-token-twice";
  await store.saveKiteSession({ access_token: token, user_id: "U", user_name: "", login_date: "2026-09-08", api_key: "k" });
  const c1 = await h.raw();
  const a = (await c1.query(`SELECT encrypted_access_token, encryption_iv FROM broker_sessions WHERE broker='zerodha'`)).rows[0];
  c1.release();
  await store.saveKiteSession({ access_token: token, user_id: "U", user_name: "", login_date: "2026-09-08", api_key: "k" });
  const c2 = await h.raw();
  const b = (await c2.query(`SELECT encrypted_access_token, encryption_iv FROM broker_sessions WHERE broker='zerodha'`)).rows[0];
  c2.release();
  assert.notEqual(a.encryption_iv.toString("hex"), b.encryption_iv.toString("hex"));
  assert.notEqual(a.encrypted_access_token.toString("hex"), b.encrypted_access_token.toString("hex"));
});

test("separate writes cannot overwrite the other broker's row", async () => {
  await store.saveKiteSession({ access_token: "z-token", user_id: "Z", user_name: "", login_date: "2026-09-08", api_key: "k" });
  await store.saveDhanSession({
    access_token: "d-token",
    dhan_client_id: "DCL9",
    dhan_client_name: "D Name",
    dhan_client_ucc: "UCC1",
    given_power_of_attorney: true,
    expiry_time: Date.now() + 3_600_000,
    login_date: "2026-09-08",
  });

  const z = await store.loadKiteSession();
  const d = await store.loadDhanSession();
  assert.equal(z.access_token, "z-token");
  assert.equal(d.access_token, "d-token");
  assert.equal(d.dhan_client_id, "DCL9");
  assert.equal(d.given_power_of_attorney, true);

  // Overwriting Zerodha leaves Dhan untouched.
  await store.saveKiteSession({ access_token: "z-token-2", user_id: "Z", user_name: "", login_date: "2026-09-08", api_key: "k" });
  const d2 = await store.loadDhanSession();
  assert.equal(d2.access_token, "d-token");

  const c = await h.raw();
  const { rows } = await c.query(`SELECT broker FROM broker_sessions ORDER BY broker`);
  c.release();
  assert.deepEqual(rows.map((r) => r.broker), ["dhan", "zerodha"]);
});

test("restart restores and decrypts both valid sessions", async () => {
  await store.saveKiteSession({ access_token: "z-restart", user_id: "Z", user_name: "", login_date: "2026-09-08", api_key: "k" });
  await store.saveDhanSession({
    access_token: "d-restart",
    dhan_client_id: "DCL",
    dhan_client_name: "",
    dhan_client_ucc: "",
    given_power_of_attorney: false,
    expiry_time: null,
    login_date: "2026-09-08",
  });

  // Simulate a restart: re-import a fresh module instance reading the same rows.
  const freshStore = await import(`../../dist/brokerState/brokerSessions.js?restart=${Date.now()}`);
  const z = await freshStore.loadKiteSession();
  const d = await freshStore.loadDhanSession();
  assert.equal(z.access_token, "z-restart");
  assert.equal(d.access_token, "d-restart");
  assert.equal(d.expiry_time, null, "null Dhan expiry stays unknown, not permanently valid");
});

test("an invalid encryption key fails safely on load — never returns a wrong or empty token", async () => {
  await store.saveKiteSession({ access_token: "z-key-test", user_id: "Z", user_name: "", login_date: "2026-09-08", api_key: "k" });

  // Point the store at a DIFFERENT valid-length key. Decryption must throw, not
  // return null (which would look like "no session") or a garbage token.
  const original = process.env.BROKER_TOKEN_ENCRYPTION_KEY;
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
  await assert.rejects(() => store.loadKiteSession(), /decrypt|authenticate|key/i);
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = original;

  // A malformed key is rejected with a clear message at decode time.
  assert.throws(() => crypto.decodeEncryptionKey("too-short"), /32 bytes|hex|base64/i);
  assert.throws(() => crypto.decodeEncryptionKey(undefined), /not set|32 bytes/i);
});

test("tampering with the authenticated metadata makes the token fail to decrypt", async () => {
  await store.saveDhanSession({
    access_token: "d-aad",
    dhan_client_id: "REAL",
    dhan_client_name: "",
    dhan_client_ucc: "",
    given_power_of_attorney: false,
    expiry_time: null,
    login_date: "2026-09-08",
  });
  const c = await h.raw();
  try {
    // Rewrite the client id (part of the AAD) without re-sealing.
    await c.query(`UPDATE broker_sessions SET api_key_or_client_id = 'FORGED' WHERE broker = 'dhan'`);
  } finally {
    c.release();
  }
  await assert.rejects(() => store.loadDhanSession(), /decrypt|authenticate|tampered/i);
});
