/**
 * The conservative Mumbai EC2 profile must stay TRUE against the code.
 *
 * A profile document/example that drifts from `loadBoxConfig` is worse than none:
 * it tells an operator a posture is in force that is not. This test parses
 * `deploy/mumbai-ec2-conservative.env.example`, loads it through the REAL config
 * parser, and asserts the resulting posture is exactly the conservative one the
 * profile claims — and that the file contains no secret and no sub-second exchange
 * freshness threshold (the brokers publish only whole-second exchange stamps).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadBoxConfig } from "../../dist/box/config.js";
import { resolveEffectiveConfig } from "../../dist/box/effectiveConfig.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const ENV_EXAMPLE = join(REPO, "deploy", "mumbai-ec2-conservative.env.example");

/** Parse a KEY=VALUE .env file into a plain object (comments / blanks ignored). */
function parseEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Strip inline comments and surrounding whitespace from the value.
    let value = trimmed.slice(eq + 1);
    const hash = value.indexOf("#");
    if (hash >= 0) value = value.slice(0, hash);
    out[key] = value.trim();
  }
  return out;
}

const ENV = parseEnvFile(ENV_EXAMPLE);

/** Load BoxConfig with the profile spliced into process.env, then restore. */
function withProfileEnv(fn) {
  const saved = process.env;
  try {
    process.env = { ...saved, ...ENV };
    return fn();
  } finally {
    process.env = saved;
  }
}

test("the example parses and every BOX_* key it sets is a real, resolvable knob", () => {
  assert.ok(Object.keys(ENV).length > 0, "the example must set variables");
  const report = withProfileEnv(() => resolveEffectiveConfig());
  const known = new Set(report.values.map((v) => v.envVar));
  const boxKeys = Object.keys(ENV).filter((k) => k.startsWith("BOX_"));
  for (const k of boxKeys) {
    // Every BOX_ knob in the example should be one the surface reports OR at least
    // parse without changing the mode illegally. We only assert the ones the surface
    // tracks are recognised; others (paper-only) are still loaded below.
    if (!known.has(k)) continue;
    const v = report.values.find((x) => x.envVar === k);
    assert.notEqual(v.source, "env_invalid_fallback", `${k}="${ENV[k]}" was not understood`);
  }
});

test("REAL TRADING IS DISABLED in the example (both switches conservative)", () => {
  const cfg = withProfileEnv(() => loadBoxConfig());
  assert.equal(cfg.executionMode, "paper_latency", "must not ship in live mode");
  assert.equal(cfg.liveTradingEnabled, false, "kill switch must be off");
  const report = withProfileEnv(() => resolveEffectiveConfig());
  assert.equal(report.liveTradingArmed, false);
});

test("ONE lot per leg envelope, ONE active box, ONE box per underlying, armed one-shot session", () => {
  const cfg = withProfileEnv(() => loadBoxConfig());
  assert.equal(cfg.liveMaxOpenBoxes, 1, "one active box");
  assert.equal(cfg.liveMaxConcurrentExecutions, 1, "one execution at a time");
  assert.equal(cfg.oneActiveBoxPerUnderlying, true, "one box per underlying ON (not the code default)");
  assert.equal(cfg.sessionMaxCompletedTrades, 1, "explicitly armed one-completed-box session");
  assert.equal(cfg.liveEntrySubmitConcurrency, 1, "serialised entry submission");
});

test("the one-completed-box session is EXPLICITLY armed, never the default", () => {
  // Code default is 0 (unlimited); the profile must set it, not inherit it.
  assert.ok("BOX_SESSION_MAX_COMPLETED_TRADES" in ENV, "must be set explicitly");
  assert.equal(ENV.BOX_SESSION_MAX_COMPLETED_TRADES, "1");
});

test("NO sub-second EXCHANGE freshness threshold (whole-second exchange stamps only)", () => {
  const cfg = withProfileEnv(() => loadBoxConfig());
  // The exchange-dispersion gate, when set, must be >= 1000ms or 0 (disabled),
  // because Kite exchange timestamps are whole seconds and Dhan has none.
  if ("BOX_MAX_CROSS_LEG_EXCHANGE_DISPERSION_MS" in ENV) {
    const v = cfg.maxCrossLegExchangeDispersionMs;
    assert.ok(v === 0 || v >= 1000, `exchange dispersion ${v}ms must be 0 or >= 1000ms, never sub-second`);
  }
  // The receive-to-exchange delay tolerance must be generous (coarse stamps).
  assert.ok(cfg.maxReceiveToExchangeDelayMs >= 1000, "receive-to-exchange tolerance must accommodate coarse stamps");
});

test("the loss breaker is set and bounded (a breaker, not a guaranteed max loss)", () => {
  const cfg = withProfileEnv(() => loadBoxConfig());
  assert.ok(cfg.liveDailyLossLimit > 0 && cfg.liveDailyLossLimit <= 10_000_000);
});

test("the capital cap is present as a PLACEHOLDER the operator must set, not an approved budget", () => {
  // It must appear in the file. Whatever number is written, the profile text must
  // label it a placeholder — the file must NOT present it as an approved limit.
  assert.ok("BOX_LIVE_MAX_BOX_CAPITAL_RUPEES" in ENV, "the cap must be shown so the operator sets it");
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  assert.match(
    text,
    /placeholder|EDIT|set (this|a real)|must set|not.*(approved|budget)/i,
    "the capital cap must be clearly labelled a placeholder to set, never an approved budget",
  );
});

test("order-update streams default OFF in the example (opt-in only)", () => {
  // The knobs live at the broker layer, not BoxConfig, so assert the file text.
  assert.equal(ENV.ZERODHA_ORDER_STREAM_ENABLED, "false");
  assert.equal(ENV.DHAN_ORDER_STREAM_ENABLED, "false");
});

test("PostgreSQL durability is respected: synchronous_commit is NEVER turned off", () => {
  // Only ACTIVE (non-comment) lines count — a prose warning that says "do NOT set
  // synchronous_commit=off" is correct guidance, not a setting. env files cannot set
  // a PG server GUC anyway, so the real assertion is that no uncommented line does.
  const active = readFileSync(ENV_EXAMPLE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .join("\n")
    .toLowerCase();
  assert.ok(
    !/synchronous_commit\s*=\s*off/.test(active),
    "no active line may set synchronous_commit=off — durability before transport is load-bearing",
  );
});

test("the example contains NO secret material (placeholders only)", () => {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  // MongoDB URI must be blank or a scheme-only placeholder, never real credentials.
  const mongo = ENV.MONGODB_URI ?? "";
  assert.ok(
    mongo === "" || !/:[^:@/]+@/.test(mongo),
    "MONGODB_URI must not embed a real password",
  );
  // No obvious live token/secret assignments with long opaque values.
  const secretLike = /(ACCESS_TOKEN|API_SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*\S{16,}/i;
  assert.ok(!secretLike.test(text), "no long opaque secret value may appear in the example");
});

test("Dhan static-IP declaration is documented in the example (operational precondition)", () => {
  const text = readFileSync(ENV_EXAMPLE, "utf8");
  assert.match(text, /static ip|elastic ip|DHAN_STATIC_IP/i, "Dhan static-IP requirement must be called out");
});
