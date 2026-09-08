/**
 * REGRESSION GUARD for the hermetic-network property.
 *
 * The suite used to make 24 real HTTPS calls to live broker endpoints per run (23 to
 * images.dhan.co for the ~201k-row scrip master, 1 to api.kite.trade). These tests pin
 * the mechanism that stops that from ever coming back:
 *
 *   1. The guard FAILS CLOSED — an unstubbed non-loopback host throws, naming the URL.
 *      This is the property that makes an accidental future dial-out a red test rather
 *      than a silent egress.
 *   2. The guard SERVES the Dhan scrip master from the checked-in fixture (parsed by the
 *      REAL parser) and the Zerodha dump from the stub, so the code paths that need them
 *      still work fully offline.
 *   3. Loopback (PostgreSQL / MongoDB) is always allowed.
 *   4. A representative slice of the real switch path performs ZERO non-loopback fetches
 *      once armed — proven by driving DhanInstrumentStore through the interceptor and
 *      inspecting the recorded call hosts.
 *   5. restore() puts the original fetch back so the guard cannot leak between files.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { installHermeticNetwork, nonLoopbackHosts } from "../helpers/hermeticNetwork.mjs";
import { parseDhanScripMaster, DhanInstrumentStore } from "../../dist/brokers/dhan/instruments.js";

let hermetic;
before(() => {
  hermetic = installHermeticNetwork();
});
after(() => {
  hermetic?.restore();
});

test("FAIL CLOSED: an unstubbed non-loopback host throws, naming the URL", async () => {
  await assert.rejects(
    () => fetch("https://images.example.com/whatever"),
    (err) => {
      assert.match(err.message, /HERMETIC NETWORK VIOLATION/);
      assert.match(err.message, /images\.example\.com/);
      return true;
    },
  );
});

test("the live Dhan master URL never reaches the network — it is served from the fixture", async () => {
  const res = await fetch("https://images.dhan.co/api-data/api-scrip-master-detailed.csv");
  assert.equal(res.ok, true);
  const csv = await res.text();
  const rows = parseDhanScripMaster(csv);
  // The fixture is a TRIMMED sample; the property we assert is that it parses into a
  // real, non-empty universe with both an NFO future and an NFO option present — not a
  // brittle count of the live master.
  assert.ok(rows.length > 0, "the fixture parses into a non-empty universe");
  assert.ok(
    rows.some((r) => r.exchange === "NFO" && r.instrument_type === "FUT"),
    "the fixture contains at least one NFO future",
  );
  assert.ok(
    rows.some((r) => r.exchange === "NFO" && r.instrument_type === "CE"),
    "the fixture contains at least one NFO call option",
  );
  assert.ok(
    rows.some((r) => r.exchange === "NFO" && r.instrument_type === "PE"),
    "the fixture contains at least one NFO put option",
  );
  assert.ok(
    rows.some((r) => r.instrument_type === "INDEX"),
    "the fixture contains at least one index",
  );
  assert.ok(
    rows.some((r) => r.instrument_type === "EQ"),
    "the fixture contains at least one equity",
  );
});

test("the fallback master URL is also served from the fixture, not the network", async () => {
  const res = await fetch("https://images.dhan.co/api-data/api-scrip-master.csv");
  assert.equal(res.ok, true);
  const csv = await res.text();
  assert.ok(parseDhanScripMaster(csv).length > 0);
});

test("the Zerodha instrument dump is served from the stub, not api.kite.trade", async () => {
  const res = await fetch("https://api.kite.trade/instruments");
  assert.equal(res.ok, true);
  const csv = await res.text();
  assert.match(csv, /instrument_token,exchange_token,tradingsymbol/, "the exact Kite header");
});

test("loopback is always allowed to pass through (PostgreSQL / MongoDB)", () => {
  // The guard must never throw for a loopback host; we only assert the classification
  // here rather than opening a real socket, since no loopback HTTP server is running.
  const h = installHermeticNetwork();
  try {
    assert.equal(typeof h.stub, "function");
    // A loopback URL is not treated as a violation.
    assert.doesNotThrow(() => nonLoopbackHosts(["http://127.0.0.1:5432/", "http://localhost/x"]));
    assert.deepEqual(nonLoopbackHosts(["http://127.0.0.1:5432/", "http://localhost/x"]), []);
  } finally {
    h.restore();
  }
});

test("REPRESENTATIVE SLICE: a real DhanInstrumentStore load performs ZERO non-loopback fetches", async () => {
  // A fresh guard so the recorded calls reflect ONLY this load path.
  const h = installHermeticNetwork();
  try {
    const store = new DhanInstrumentStore();
    const rows = await store.load(true);
    assert.ok(rows.length > 0, "the store loaded the fixture universe");
    // Every URL the guard saw during the real load path must be to images.dhan.co only —
    // and served from the fixture, which the guard records but never forwards to the net.
    const hosts = nonLoopbackHosts(h.calls);
    assert.deepEqual(
      hosts,
      ["images.dhan.co"],
      "the only broker host touched was the intercepted Dhan master (served from fixture)",
    );
  } finally {
    h.restore();
  }
});

test("an explicitly registered stub takes precedence and is served", async () => {
  const h = installHermeticNetwork();
  try {
    h.stub("api.dhan.co", () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await fetch("https://api.dhan.co/v2/orders");
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    h.restore();
  }
});

test("restore() puts the original fetch back so the guard cannot leak between files", () => {
  const before = globalThis.fetch;
  const h = installHermeticNetwork();
  assert.notEqual(globalThis.fetch, before, "install replaces fetch");
  h.restore();
  assert.equal(globalThis.fetch, before, "restore returns the exact original reference");
});
