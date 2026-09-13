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


/* ─────────── CANDIDATE-SCOPED admission is WIRED, and the global gate is not overloaded ─────────── */

test("the transport READY test is EXISTENTIAL, not a universe-wide universal quantifier", () => {
  // THE DEFECT: reevaluate() required `everyDesiredFresh(now)` — every desired instrument fresh —
  // while the engine supplied subscribedOptionTokens, the ENTIRE streamed option universe. READY is
  // the only market-data state that licenses new entry, so one illiquid unrelated strike refused
  // every box with feed_unhealthy. If `everyDesiredFresh` ever comes back as the READY predicate,
  // that outage comes back with it.
  const policy = code("streamHealthPolicy.ts");
  assert.ok(
    !policy.includes("everyDesiredFresh"),
    "the universe-wide universal quantifier must not gate READY again",
  );
  assert.ok(
    policy.includes("anyDesiredFresh"),
    "READY must be an EXISTENTIAL test: the depth pipeline is demonstrably delivering",
  );
  // And the case the universal quantifier was defending against must still be caught.
  assert.ok(
    policy.includes("if (this.desired.size === 0) return false"),
    "an empty subscription set must never read READY — readiness is not claimed from silence",
  );
});

test("the engine supplies CANDIDATE-SCOPED market-data admission to the execution gateway", () => {
  const engine = code("engine.ts");
  assert.ok(
    engine.includes("candidateMarketDataAdmissible:"),
    "the engine must supply the candidate-scoped gate, not only the transport gate",
  );
  assert.ok(
    engine.includes("evaluateCandidateMarketData("),
    "and it must be evaluated from the real per-candidate helper",
  );
  // Every input must be read LIVE, so no cached verdict can survive a candidate switch or reconnect.
  assert.ok(
    engine.includes("isInstrumentReady: (token) => this.marketDataMachine.isInstrumentReady(token)"),
    "per-leg readiness must come from the machine's per-instrument generation-scoped freshness",
  );
  assert.ok(
    engine.includes("isSubscribed: (token) => this.marketDataMachine.isSubscribed(token)"),
    "per-leg subscription coverage must be consulted",
  );
});

test("the execution gateway enforces the candidate gate at the checkpoint AND at the send boundary", () => {
  const gateway = code("executionGateway.ts");
  const uses = gateway.split("this.deps.candidateMarketDataAdmissible?.(").length - 1;
  assert.ok(
    uses >= 2,
    `the candidate gate must be re-asked immediately before submission, not only at the checkpoint (found ${uses} call sites)`,
  );
  // The send-boundary hook is the one that runs immediately before the broker POST.
  const sendBoundary = gateway.slice(gateway.indexOf("sendBoundaryCoherence: () =>"));
  assert.ok(
    sendBoundary.slice(0, 900).includes("candidateMarketDataAdmissible"),
    "the send-boundary hook must re-check the candidate's market-data evidence",
  );
});

test("the per-instrument accessors the candidate gate needs are actually reachable", () => {
  // isInstrumentReady()/readyInstruments() existed for a long time with NO production caller, which
  // is how the per-leg intent stayed unimplemented while the transport gate was overloaded instead.
  const policy = code("streamHealthPolicy.ts");
  for (const fn of ["isInstrumentReady(", "isSubscribed(", "coverage("]) {
    assert.ok(policy.includes(fn), `${fn} must exist on the machine`);
  }
  const engine = code("engine.ts");
  for (const fn of ["isInstrumentReady(", "isSubscribed("]) {
    assert.ok(engine.includes(`this.marketDataMachine.${fn}`), `${fn} must have a PRODUCTION caller`);
  }
});
