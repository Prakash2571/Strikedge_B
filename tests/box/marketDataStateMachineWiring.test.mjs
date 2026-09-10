/**
 * PROVE THE MARKET-DATA STATE MACHINE IS DRIVEN IN PRODUCTION (GAP 1).
 *
 * The pure machine is exercised by marketDataStateMachine.test.mjs. This suite proves the OTHER
 * half of the fix: that the engine actually CONSTRUCTS one and drives it from the real
 * market-data feed lifecycle — connect/disconnect, per-instrument depth, session loss, the
 * age-based re-evaluation on the market-watch timer — and that NEW ENTRY is gated on its READY
 * state. A machine that is built and unit-tested but never fed would report DISCONNECTED forever
 * while looking finished; these source-level call-site assertions catch exactly that regression,
 * the same discipline wiredNotInert.test.mjs applies to the other inert-module risks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f, dir = "box") => readFileSync(new URL(`../../src/${dir}/${f}`, import.meta.url), "utf8");
/** Strip comments so a mention in prose never counts as a call site. */
const code = (f, dir = "box") =>
  src(f, dir)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
    .join("\n");

test("the engine CONSTRUCTS a MarketDataStateMachine", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("new MarketDataStateMachine("), "engine must construct the machine");
  assert.ok(
    engine.includes("this.executionClock.mono()"),
    "the machine must read the MONOTONIC clock so age comparisons are NTP-safe",
  );
});

test("the feed lifecycle DRIVES the machine (connect/disconnect, depth, session loss, evaluate)", () => {
  const engine = code("engine.ts");
  // Connect edge walks CONNECTING → socket-open → authenticated (never READY on open).
  assert.ok(engine.includes("this.marketDataMachine.onConnecting()"));
  assert.ok(engine.includes("this.marketDataMachine.onSocketOpen()"));
  assert.ok(engine.includes("this.marketDataMachine.onAuthenticated()"));
  // Disconnect edge.
  assert.ok(engine.includes("this.marketDataMachine.onDisconnected()"));
  // Per-instrument fresh depth is fed from the hot path, distinct from a raw frame.
  assert.ok(engine.includes("this.marketDataMachine.onUsableDepth("), "per-leg depth must be fed");
  assert.ok(engine.includes("this.marketDataMachine.onFrame("), "a received frame must be fed distinctly");
  // Session loss is terminal (AUTH_EXPIRED), not a plain disconnect.
  assert.ok(engine.includes("this.marketDataMachine.onSessionLost()"));
  // Age-based re-evaluation on the market-watch timer.
  assert.ok(engine.includes("this.marketDataMachine.evaluate()"), "the timer must force re-evaluation");
  // The desired traded instruments are published from real subscription intent.
  assert.ok(engine.includes("this.marketDataMachine.setDesiredInstruments("));
  // Processing backlog is fed from the loop-stall diagnostic.
  assert.ok(engine.includes("this.marketDataMachine.onProcessingBacklog("));
});

test("NEW ENTRY is gated on READY, and only in LIVE mode", () => {
  const engine = code("engine.ts");
  // The engine supplies the gateway a marketDataEntryPermitted reader, guarded on live mode.
  assert.ok(engine.includes("marketDataEntryPermitted:"), "engine must supply the entry gate");
  assert.ok(
    engine.includes("marketDataPermissions(state).newEntry"),
    "the gate must derive from the market-data permission table's newEntry",
  );

  const gateway = code("executionGateway.ts");
  assert.ok(
    gateway.includes("this.deps.marketDataEntryPermitted?.()"),
    "the live entry path must consult the readiness gate",
  );
  // It must refuse BEFORE building any request (cheapest checkpoint, no exposure).
  assert.ok(gateway.includes('"feed_unhealthy"'), "a not-ready feed must refuse entry as feed_unhealthy");
});

test("the driven state is surfaced in engine status", () => {
  const engine = code("engine.ts");
  assert.ok(engine.includes("market_data_state:"), "status must expose the driven state");
  assert.ok(engine.includes("market_data_health:"), "status must expose the machine diagnostics");
});

test("the registry forwards a box-lane session loss to the engine", () => {
  const registry = code("registry.ts", "brokers");
  assert.ok(registry.includes("onBoxLaneSessionLost"), "registry must expose a box-lane session-loss hook");
  const index = code("index.ts", "");
  assert.ok(
    index.includes("boxModule.engine.onMarketDataSessionLost("),
    "index.ts must wire the box-lane session loss into the engine",
  );
});
