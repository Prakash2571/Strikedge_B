/**
 * Redaction guarantees.
 *
 * Proves: neither broker token can enter the Mongo outbox; neither token appears in
 * any log line produced while acquiring one; neither token appears in the status
 * object. The outbox deny list is the enforcement point, asserted directly.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecretFields, OutboxSecretLeakError } from "../../dist/outbox/writer.js";
import { BrokerTokenAcquisitionService } from "../../dist/tokens/brokerTokenService.js";
import {
  createPgHarness,
  makeFakeClock,
  makeMockProvider,
  istInstant,
  nullFeedProbe,
  TEST_KEY_HEX,
} from "./helpers.mjs";

test("the outbox rejects a payload carrying a broker access token or ciphertext", () => {
  assert.throws(() => assertNoSecretFields({ access_token: "leak" }), OutboxSecretLeakError);
  assert.throws(() => assertNoSecretFields({ nested: { encrypted_access_token: "x" } }), OutboxSecretLeakError);
  assert.throws(() => assertNoSecretFields({ a: [{ encryption_iv: "x" }] }), OutboxSecretLeakError);
  assert.throws(() => assertNoSecretFields({ token_passcode: "p" }), OutboxSecretLeakError);
  assert.throws(() => assertNoSecretFields({ broker_token_encryption_key: "k" }), OutboxSecretLeakError);
  // A safe projection payload passes.
  assert.doesNotThrow(() => assertNoSecretFields({ broker: "zerodha", login_date: "2026-09-08", generation: 3 }));
});

test("neither token appears in logs during acquisition, and never in the status object", async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  const h = await createPgHarness("redact");
  const store = await import("../../dist/brokerState/brokerSessions.js");
  const mock = makeMockProvider();
  const urls = await mock.listen();

  // Capture everything written to the console.
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }

  const SECRET_Z = "ZERODHA_SECRET_TOKEN_zzz";
  const SECRET_D = "DHAN_SECRET_TOKEN_ddd";
  const PASS_Z = "zerodha-passcode-XYZ";
  const PASS_D = "dhan-passcode-QRS";

  try {
    mock.setResponder("zerodha", () => ({
      status: 200,
      body: { authenticated: true, api_key: "k", access_token: SECRET_Z, login_date: "2026-09-08" },
    }));
    mock.setResponder("dhan", () => ({
      status: 200,
      body: { authenticated: true, client_id: "DCL", access_token: SECRET_D, expires_at: null, login_date: "2026-09-08" },
    }));

    const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
    const svc = new BrokerTokenAcquisitionService({
      clock,
      configs: {
        zerodha: { url: urls.zerodhaUrl, passcode: PASS_Z, requestTimeoutMs: 1500, requireHttps: false, expectedIdentity: "k" },
        dhan: { url: urls.dhanUrl, passcode: PASS_D, requestTimeoutMs: 1500, requireHttps: false, expectedIdentity: "DCL" },
      },
      callbacks: {
        installZerodhaToken: () => {},
        installDhanToken: () => {},
        isActiveBroker: () => true,
        onActiveBrokerReady: () => {},
        onBrokerAuthFailure: () => {},
      },
      feedProbe: nullFeedProbe(),
      pollStart: "09:00",
      pollIntervalMs: 60_000,
      persist: {
        saveZerodha: (r) => store.saveKiteSession({ access_token: r.accessToken, user_id: "", user_name: "", login_date: r.loginDate, api_key: r.apiKey }),
        saveDhan: (r) =>
          store.saveDhanSession({
            access_token: r.accessToken,
            dhan_client_id: r.clientId,
            dhan_client_name: "",
            dhan_client_ucc: "",
            given_power_of_attorney: false,
            expiry_time: r.expiresAtMs,
            login_date: r.loginDate,
          }),
        hasValidToken: async () => false,
        invalidate: () => Promise.resolve(),
      },
    });

    await svc.start();
    await new Promise((r) => setTimeout(r, 80));

    const status = JSON.stringify(svc.status());
    svc.stop();

    // Status must not carry a token or passcode.
    assert.equal(status.includes(SECRET_Z), false);
    assert.equal(status.includes(SECRET_D), false);
    assert.equal(status.includes(PASS_Z), false);
    assert.equal(status.includes(PASS_D), false);

    // No log line may carry a token or passcode.
    const joined = logs.join("\n");
    assert.equal(joined.includes(SECRET_Z), false, "Zerodha token leaked to a log");
    assert.equal(joined.includes(SECRET_D), false, "Dhan token leaked to a log");
    assert.equal(joined.includes(PASS_Z), false, "Zerodha passcode leaked to a log");
    assert.equal(joined.includes(PASS_D), false, "Dhan passcode leaked to a log");
  } finally {
    Object.assign(console, orig);
    await mock.close();
    await h.cleanup();
  }
});
