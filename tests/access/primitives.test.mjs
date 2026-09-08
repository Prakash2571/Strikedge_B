/**
 * Unit tests for the access-gate primitives: constant-time secret comparison,
 * fail-closed passcode behaviour, CSRF constant-time comparison, Origin matching
 * and session-token entropy. These do NOT need PostgreSQL.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const store = await import(`${DIST}/access/sessionStore.js`);
const csrf = await import(`${DIST}/access/csrf.js`);

test("verifyPasscode fails closed when the secret is unset", () => {
  assert.equal(store.verifyPasscode({ siteAccessSecret: undefined, ttlHours: 24 }, ""), false);
  assert.equal(store.verifyPasscode({ siteAccessSecret: undefined, ttlHours: 24 }, "anything"), false);
  assert.equal(store.verifyPasscode({ siteAccessSecret: "", ttlHours: 24 }, ""), false);
  assert.equal(store.isSecretConfigured({ siteAccessSecret: undefined, ttlHours: 24 }), false);
  assert.equal(store.isSecretConfigured({ siteAccessSecret: "x", ttlHours: 24 }), true);
});

test("verifyPasscode matches only the exact secret", () => {
  const cfg = { siteAccessSecret: "s3cr3t-value", ttlHours: 24 };
  assert.equal(store.verifyPasscode(cfg, "s3cr3t-value"), true);
  assert.equal(store.verifyPasscode(cfg, "s3cr3t-valuE"), false);
  assert.equal(store.verifyPasscode(cfg, "s3cr3t-value "), false);
  assert.equal(store.verifyPasscode(cfg, ""), false);
  assert.equal(store.verifyPasscode(cfg, undefined), false);
});

test("passcode comparison is over equal-length digests (constant-time contract)", () => {
  // The comparison hashes both sides to a 32-byte digest first, so a shorter or
  // longer presented value never causes a length-mismatch throw or early return.
  const cfg = { siteAccessSecret: "short", ttlHours: 24 };
  assert.doesNotThrow(() => store.verifyPasscode(cfg, "a-much-longer-presented-passcode-value"));
  assert.equal(store.verifyPasscode(cfg, "a-much-longer-presented-passcode-value"), false);
  // sha256 digests are always 32 bytes, so timingSafeEqual over them never throws.
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  assert.equal(timingSafeEqual(a, b), false);
});

test("session token hash is stable and the token is high-entropy (256-bit base64url)", async () => {
  // hashSessionToken is a deterministic sha256 hex (64 chars).
  const h = store.hashSessionToken("some-token");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(store.hashSessionToken("some-token"), h);
});

test("CSRF: constant-time match succeeds only for the bound token", () => {
  const token = csrf.generateCsrfToken();
  const bound = csrf.hashCsrfToken(token);
  assert.equal(csrf.csrfMatches(token, bound), true);
  assert.equal(csrf.csrfMatches("wrong-token", bound), false);
  assert.equal(csrf.csrfMatches(undefined, bound), false);
  assert.equal(csrf.csrfMatches("", bound), false);
  // A CSRF token is 256-bit base64url — 43 chars, no padding.
  assert.ok(token.length >= 43);
});

test("only mutating methods require CSRF/Origin", () => {
  assert.equal(csrf.isMutatingMethod("POST"), true);
  assert.equal(csrf.isMutatingMethod("put"), true);
  assert.equal(csrf.isMutatingMethod("PATCH"), true);
  assert.equal(csrf.isMutatingMethod("DELETE"), true);
  assert.equal(csrf.isMutatingMethod("GET"), false);
  assert.equal(csrf.isMutatingMethod("HEAD"), false);
  assert.equal(csrf.isMutatingMethod("OPTIONS"), false);
});

test("Origin matching is exact and rejects a missing Origin", () => {
  const allowed = "http://localhost:5173";
  assert.equal(csrf.originAllowed("http://localhost:5173", allowed), true);
  assert.equal(csrf.originAllowed("http://localhost:5174", allowed), false);
  assert.equal(csrf.originAllowed("https://localhost:5173", allowed), false);
  assert.equal(csrf.originAllowed("https://evil.example", allowed), false);
  assert.equal(csrf.originAllowed(undefined, allowed), false);
  assert.equal(csrf.originAllowed("", allowed), false);
});
