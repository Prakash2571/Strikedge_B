/**
 * FINDING A — the CSRF header/cookie names are single-sourced from the contract.
 *
 * The header name "x-csrf-token" and the CSRF cookie naming were previously
 * hardcoded independently in the backend (src/access/csrf.ts CSRF_HEADER) and in the
 * frontend (src/api/http.ts). Each repo tested only its OWN literal, so a one-sided
 * rename would pass its own CI while silently breaking authentication.
 *
 * contract/protocol.json is now the SINGLE SOURCE OF TRUTH for these names, and it is
 * covered by the digest in contract/digest.mjs (so any rename there changes
 * schemas_sha256 and forces a coordinated version bump). These tests pin the BACKEND
 * to that contract:
 *
 *   1. CSRF_HEADER (src/access/csrf.ts) === protocol.json csrf_header
 *   2. csrfCookieName(config) === <sessionCookieName><csrf_cookie_suffix>
 *   3. the default session cookie name in src/config.ts === protocol.json
 *      session_cookie_default
 *
 * A rename on EITHER side (backend constant or contract file) now FAILS the backend
 * contract suite. The frontend, per contract/README.md, must READ the header name
 * from the vendored contract rather than hardcode its own copy — so a one-sided
 * rename can no longer pass any repo's CI.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");
const ROOT = resolve(HERE, "..", "..");

const protocol = JSON.parse(readFileSync(resolve(ROOT, "contract", "protocol.json"), "utf8"));

test("protocol.json carries the CSRF constants in a machine-readable shape", () => {
  assert.equal(typeof protocol.csrf_header, "string");
  assert.ok(protocol.csrf_header.length > 0, "csrf_header must be non-empty");
  assert.equal(typeof protocol.session_cookie_default, "string");
  assert.ok(protocol.session_cookie_default.length > 0, "session_cookie_default must be non-empty");
  assert.equal(typeof protocol.csrf_cookie_suffix, "string");
  assert.ok(protocol.csrf_cookie_suffix.length > 0, "csrf_cookie_suffix must be non-empty");
});

test("backend CSRF_HEADER equals the contract's csrf_header (rename on either side fails here)", async () => {
  const { CSRF_HEADER } = await import(`${DIST}/access/csrf.js`);
  assert.equal(
    CSRF_HEADER,
    protocol.csrf_header,
    "src/access/csrf.ts CSRF_HEADER drifted from contract/protocol.json csrf_header — " +
      "a one-sided rename would break authentication against the frontend that reads the contract.",
  );
});

test("csrfCookieName(config) equals <sessionCookieName><csrf_cookie_suffix>", async () => {
  const { csrfCookieName } = await import(`${DIST}/access/cookies.js`);
  // A minimal AppConfig — only sessionCookieName is consulted by csrfCookieName.
  const cfg = { sessionCookieName: protocol.session_cookie_default };
  assert.equal(
    csrfCookieName(cfg),
    `${protocol.session_cookie_default}${protocol.csrf_cookie_suffix}`,
    "csrfCookieName no longer composes <sessionCookieName><csrf_cookie_suffix> from the contract.",
  );

  // And with a non-default session cookie name it must still be the suffix rule.
  const custom = { sessionCookieName: "acme_sess" };
  assert.equal(csrfCookieName(custom), `acme_sess${protocol.csrf_cookie_suffix}`);
});

test("the default SESSION_COOKIE_NAME in src/config.ts equals protocol.json session_cookie_default", async () => {
  const { loadAppConfig } = await import(`${DIST}/config.js`);
  // Load with SESSION_COOKIE_NAME unset so the DEFAULT is exercised. Provide only the
  // other required fields so config validation passes hermetically.
  const cfg = loadAppConfig({
    NODE_ENV: "test",
    FRONTEND_URL: "http://127.0.0.1:5173",
    // SESSION_COOKIE_NAME intentionally omitted -> default path.
  });
  assert.equal(
    cfg.sessionCookieName,
    protocol.session_cookie_default,
    "src/config.ts default session cookie name drifted from contract/protocol.json session_cookie_default.",
  );
});
