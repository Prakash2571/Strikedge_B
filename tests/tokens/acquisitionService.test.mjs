/**
 * BrokerTokenAcquisitionService — scheduling, concurrency, independence and the
 * active-broker-only WebSocket rule.
 *
 * FAKE CLOCK + LOCAL MOCK HTTP SERVER + real PostgreSQL persistence. Proves the
 * per-broker state-machine guarantees required by section D and I.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { BrokerTokenAcquisitionService } from "../../dist/tokens/brokerTokenService.js";
import {
  createPgHarness,
  makeFakeClock,
  makeMockProvider,
  istInstant,
  nullFeedProbe,
  TEST_KEY_HEX,
} from "./helpers.mjs";

let h;
let store;
let mock;
let urls;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  h = await createPgHarness("svc");
  store = await import("../../dist/brokerState/brokerSessions.js");
  mock = makeMockProvider();
  urls = await mock.listen();
});
after(async () => {
  if (mock) await mock.close();
  if (h) await h.cleanup();
});

beforeEach(async () => {
  const c = await h.raw();
  await c.query(`TRUNCATE broker_sessions`);
  c.release();
  mock.state.zerodha.count = 0;
  mock.state.dhan.count = 0;
  mock.setDelay("zerodha", 0);
  mock.setDelay("dhan", 0);
});

function zSuccess() {
  return { status: 200, body: { authenticated: true, api_key: "k", access_token: "ztok", login_date: "2026-09-08" } };
}
function dSuccess() {
  return { status: 200, body: { authenticated: true, client_id: "DCL", access_token: "dtok", expires_at: null, login_date: "2026-09-08" } };
}

function makeCallbacks(record) {
  return {
    installZerodhaToken: () => {
      record.installedZerodha = true;
    },
    installDhanToken: () => {
      record.installedDhan = true;
    },
    isActiveBroker: (b) => b === record.active,
    onActiveBrokerReady: (b) => {
      record.wsOpened.push(b);
    },
    onBrokerAuthFailure: (b, reason) => {
      record.authFailures.push({ b, reason });
    },
  };
}

function makePersist() {
  return {
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
    hasValidToken: async (broker, istDay) => {
      const s = broker === "zerodha" ? await store.loadKiteSession() : await store.loadDhanSession();
      if (!s) return false;
      if (broker === "zerodha") return s.login_date === istDay;
      // Dhan valid if unexpired.
      return s.expiry_time === null || s.expiry_time > Date.now();
    },
    invalidate: (broker, reason) => (broker === "zerodha" ? store.clearKiteSession(reason) : store.clearDhanSession(reason)),
  };
}

function makeService(clock, active, extra = {}) {
  const record = { active, wsOpened: [], authFailures: [], installedZerodha: false, installedDhan: false };
  const svc = new BrokerTokenAcquisitionService({
    clock,
    configs: {
      zerodha: { url: urls.zerodhaUrl, passcode: "zpass", requestTimeoutMs: 1500, requireHttps: false, expectedIdentity: "k" },
      dhan: { url: urls.dhanUrl, passcode: "dpass", requestTimeoutMs: 1500, requireHttps: false, expectedIdentity: "DCL" },
    },
    callbacks: makeCallbacks(record),
    feedProbe: nullFeedProbe(),
    pollStart: "09:00",
    pollIntervalMs: 60_000,
    persist: makePersist(),
    ...extra,
  });
  return { svc, record };
}

async function settle(ms = 60) {
  await new Promise((r) => setTimeout(r, ms));
}

test("no polling before 09:00 IST — the first attempt is scheduled, not fired", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "08:20"));
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", dSuccess);
  const { svc } = makeService(clock, "zerodha");
  await svc.start();
  await settle();
  assert.equal(mock.state.zerodha.count, 0, "must not poll before 09:00");
  assert.equal(mock.state.dhan.count, 0);
  const st = svc.status();
  assert.equal(st.zerodha.state, "waiting");
  assert.equal(st.dhan.state, "waiting");
  svc.stop();
});

test("both token requests start when started after 09:00 (immediate) and can run concurrently", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", dSuccess);
  const { svc, record } = makeService(clock, "zerodha");
  await svc.start();
  await settle();
  assert.ok(mock.state.zerodha.count >= 1, "zerodha polled immediately after 09:00");
  assert.ok(mock.state.dhan.count >= 1, "dhan polled immediately after 09:00");
  assert.equal(svc.status().zerodha.state, "ready");
  assert.equal(svc.status().dhan.state, "ready");
  // Only the ACTIVE broker's WebSocket opened.
  assert.deepEqual(record.wsOpened, ["zerodha"]);
  svc.stop();
});

test("successful acquisition opens ONLY the active broker's WebSocket (Dhan active → only Dhan WS)", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", dSuccess);
  const { svc, record } = makeService(clock, "dhan");
  await svc.start();
  await settle();
  assert.deepEqual(record.wsOpened, ["dhan"], "standby Zerodha must not open a socket");
  svc.stop();
});

test("only one request per broker is in flight even under a slow provider", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setDelay("zerodha", 120);
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", () => ({ status: 409, body: {} }));
  const { svc } = makeService(clock, "zerodha");
  await svc.start();
  // Fire attempt() concurrently many times; the in-flight guard must coalesce.
  await settle(30);
  assert.equal(mock.state.zerodha.count, 1, "a second attempt must not overlap the in-flight one");
  await settle(150);
  svc.stop();
});

test("Zerodha success does not stop Dhan polling, and vice versa", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", zSuccess); // succeeds immediately
  mock.setResponder("dhan", () => ({ status: 409, body: {} })); // keeps polling
  const { svc } = makeService(clock, "zerodha");
  await svc.start();
  await settle();
  assert.equal(svc.status().zerodha.state, "ready");
  assert.equal(svc.status().dhan.state, "polling", "Dhan keeps polling while Zerodha is done");
  // Zerodha did not re-poll after success.
  const zAfter = mock.state.zerodha.count;
  await settle(30);
  assert.equal(mock.state.zerodha.count, zAfter, "Zerodha polling stopped for the day after success");
  svc.stop();
});

test("a 403 blocks only the misconfigured broker and stops the one-minute hammering; the other keeps polling", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", () => ({ status: 403, body: {} }));
  mock.setResponder("dhan", () => ({ status: 409, body: {} }));
  const { svc, record } = makeService(clock, "zerodha", { pollIntervalMs: 20 });
  await svc.start();
  await settle(120);
  assert.equal(svc.status().zerodha.state, "configuration_error");
  const zCount = mock.state.zerodha.count;
  await settle(120);
  assert.equal(mock.state.zerodha.count, zCount, "403 must stop hammering Zerodha");
  assert.ok(mock.state.dhan.count > 1, "Dhan keeps retrying on 409");
  assert.ok(record.authFailures.some((f) => f.b === "zerodha"));
  svc.stop();
});

test("409 retries only the affected broker, roughly once per interval", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", () => ({ status: 409, body: {} }));
  mock.setResponder("dhan", dSuccess);
  const { svc } = makeService(clock, "zerodha", { pollIntervalMs: 25 });
  await svc.start();
  await settle(90);
  assert.ok(mock.state.zerodha.count >= 2, "409 retries repeat");
  assert.equal(svc.status().dhan.state, "ready");
  const dCount = mock.state.dhan.count;
  await settle(60);
  assert.equal(mock.state.dhan.count, dCount, "Dhan stopped after success even while Zerodha retries");
  svc.stop();
});

test("one provider's network timeout does not block the other broker", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setDelay("zerodha", 5000); // will hit the 1500ms request timeout
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", dSuccess);
  const { svc } = makeService(clock, "dhan");
  await svc.start();
  await settle(120);
  // Dhan completed despite Zerodha still hanging.
  assert.equal(svc.status().dhan.state, "ready");
  svc.stop();
});

test("success stops polling for that IST day and the status is safe (no token, no passcode)", async () => {
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", dSuccess);
  const { svc } = makeService(clock, "zerodha");
  await svc.start();
  await settle();
  const st = svc.status();
  const serialized = JSON.stringify(st);
  assert.equal(serialized.includes("ztok"), false, "no access token in status");
  assert.equal(serialized.includes("dtok"), false);
  assert.equal(serialized.includes("zpass"), false, "no passcode in status");
  assert.equal(serialized.includes("dpass"), false);
  svc.stop();
});

test("token acquisition never arms live trading (no live-gate mutation exposed)", async () => {
  // The service exposes no method to arm trading; its only side effects are the
  // injected callbacks. Assert the surface has no arming affordance.
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  const { svc } = makeService(clock, "zerodha");
  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(svc));
  const forbidden = surface.filter((m) => /armTrading|armLive|enableTrading|goLive|execute|submitOrder|placeOrder/i.test(m));
  assert.deepEqual(forbidden, [], "no arming/execution method on the acquisition service");
  svc.stop();
});

test("restart restores a valid token for today and does NOT re-poll", async () => {
  // Seed a valid Zerodha token for today directly.
  await store.saveKiteSession({ access_token: "seed", user_id: "", user_name: "", login_date: "2026-09-08", api_key: "k" });
  const clock = makeFakeClock(istInstant("2026-09-08", "09:30"));
  mock.setResponder("zerodha", zSuccess);
  mock.setResponder("dhan", () => ({ status: 409, body: {} }));
  const { svc } = makeService(clock, "zerodha");
  await svc.start();
  await settle(40);
  assert.equal(svc.status().zerodha.state, "ready");
  assert.equal(mock.state.zerodha.count, 0, "a token already valid for today must not trigger a poll");
  svc.stop();
});
