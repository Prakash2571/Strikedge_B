/**
 * tokenProviderClient validation and HTTP classification.
 *
 * Uses a LOCAL MOCK HTTP SERVER (127.0.0.1) and a FAKE CLOCK. Never contacts
 * calspread.online. Proves the per-broker validation rules and the status→result
 * mapping, plus the passcode-header/redirect/HTTPS security posture.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fetchBrokerToken } from "../../dist/tokens/tokenProviderClient.js";
import { makeMockProvider, istInstant } from "./helpers.mjs";

let mock;
let urls;
const AT = istInstant("2026-09-08", "09:05"); // a fixed IST instant

before(async () => {
  mock = makeMockProvider();
  urls = await mock.listen();
});
after(async () => {
  if (mock) await mock.close();
});

function zCfg(extra = {}) {
  return { url: urls.zerodhaUrl, passcode: "zpass", requestTimeoutMs: 2000, requireHttps: false, ...extra };
}
function dCfg(extra = {}) {
  return { url: urls.dhanUrl, passcode: "dpass", requestTimeoutMs: 2000, requireHttps: false, ...extra };
}

test("the passcode is sent in the x-token-passcode header and NEVER in the query string", async () => {
  mock.state.passcodesSeen.length = 0;
  mock.state.queryStringsSeen.length = 0;
  mock.setResponder("zerodha", () => ({
    status: 200,
    body: { authenticated: true, api_key: "k", access_token: "tok", login_date: "2026-09-08" },
  }));
  await fetchBrokerToken("zerodha", zCfg(), AT);
  assert.equal(mock.state.passcodesSeen.at(-1), "zpass");
  assert.equal(mock.state.queryStringsSeen.at(-1), "", "query string must be empty — no passcode leak");
});

test("HTTPS is required outside tests (requireHttps default)", async () => {
  const res = await fetchBrokerToken("zerodha", { url: urls.zerodhaUrl, passcode: "z", requestTimeoutMs: 1000 }, AT);
  assert.equal(res.kind, "configuration_error");
  assert.match(res.reason, /https/i);
});

test("a redirect to another host is refused as a security error", async () => {
  mock.setResponder("zerodha", () => ({ status: 302, headers: { location: "https://evil.example.com/steal" } }));
  const res = await fetchBrokerToken("zerodha", zCfg(), AT);
  assert.equal(res.kind, "security_error");
  assert.match(res.reason, /redirect/i);
});

test("Zerodha requires today's IST login date", async () => {
  mock.setResponder("zerodha", () => ({
    status: 200,
    body: { authenticated: true, api_key: "k", access_token: "tok", login_date: "2026-09-07" },
  }));
  const stale = await fetchBrokerToken("zerodha", zCfg(), AT);
  assert.equal(stale.kind, "retry", "yesterday's Zerodha token is not today's");

  mock.setResponder("zerodha", () => ({
    status: 200,
    body: { authenticated: true, api_key: "k", access_token: "tok", login_date: "2026-09-08" },
  }));
  const fresh = await fetchBrokerToken("zerodha", zCfg(), AT);
  assert.equal(fresh.kind, "ready");
  assert.equal(fresh.payload.accessToken, "tok");
});

test("a Zerodha api_key mismatch blocks Zerodha as a security error", async () => {
  mock.setResponder("zerodha", () => ({
    status: 200,
    body: { authenticated: true, api_key: "WRONG", access_token: "tok", login_date: "2026-09-08" },
  }));
  const res = await fetchBrokerToken("zerodha", zCfg({ expectedIdentity: "EXPECTED_KEY" }), AT);
  assert.equal(res.kind, "security_error");
  assert.match(res.reason, /api_key/i);
});

test("Dhan respects an explicit future expiry even when login_date is not today", async () => {
  mock.setResponder("dhan", () => ({
    status: 200,
    body: {
      authenticated: true,
      client_id: "DCL",
      access_token: "dtok",
      expires_at: AT + 7 * 24 * 3600 * 1000,
      login_date: "2026-09-01", // older, but expiry is still valid
    },
  }));
  const res = await fetchBrokerToken("dhan", dCfg(), AT);
  assert.equal(res.kind, "ready");
  assert.equal(res.payload.expiresAtMs, AT + 7 * 24 * 3600 * 1000);
});

test("an expired Dhan token is rejected", async () => {
  mock.setResponder("dhan", () => ({
    status: 200,
    body: { authenticated: true, client_id: "DCL", access_token: "dtok", expires_at: AT - 1000, login_date: "2026-09-08" },
  }));
  const res = await fetchBrokerToken("dhan", dCfg(), AT);
  assert.equal(res.kind, "security_error");
  assert.match(res.reason, /past/i);
});

test("null Dhan expiry stays unknown (ready) — never permanently valid", async () => {
  mock.setResponder("dhan", () => ({
    status: 200,
    body: { authenticated: true, client_id: "DCL", access_token: "dtok", expires_at: null, login_date: "2026-09-08" },
  }));
  const res = await fetchBrokerToken("dhan", dCfg(), AT);
  assert.equal(res.kind, "ready");
  assert.equal(res.payload.expiresAtMs, null);
});

test("a Dhan client_id mismatch blocks Dhan", async () => {
  mock.setResponder("dhan", () => ({
    status: 200,
    body: { authenticated: true, client_id: "WRONG", access_token: "dtok", expires_at: null, login_date: "2026-09-08" },
  }));
  const res = await fetchBrokerToken("dhan", dCfg({ expectedIdentity: "DCL" }), AT);
  assert.equal(res.kind, "security_error");
  assert.match(res.reason, /client_id/i);
});

test("HTTP status classification: 409 retry, 401/403 configuration_error, 503 blocker, 5xx retry, malformed security_error", async () => {
  mock.setResponder("zerodha", () => ({ status: 409, body: {} }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "retry");

  mock.setResponder("zerodha", () => ({ status: 401, body: {} }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "configuration_error");

  mock.setResponder("zerodha", () => ({ status: 403, body: {} }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "configuration_error");

  mock.setResponder("zerodha", () => ({ status: 503, body: {} }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "blocker");

  mock.setResponder("zerodha", () => ({ status: 502, body: {} }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "retry");

  mock.setResponder("zerodha", () => ({ status: 200, body: "{not json" }));
  assert.equal((await fetchBrokerToken("zerodha", zCfg(), AT)).kind, "security_error");
});

test("a network error / timeout is a retry (does not stop polling)", async () => {
  const res = await fetchBrokerToken(
    "zerodha",
    { url: "http://127.0.0.1:1/api/kite/token", passcode: "z", requestTimeoutMs: 200, requireHttps: false },
    AT,
  );
  assert.equal(res.kind, "retry");
});
