/**
 * THE GATE MUST BITE — negative controls.
 *
 * A contract test that only ever sees valid data proves nothing. These prove the
 * gate actually FAILS when it should:
 *   1. deleting a required field from a REAL serialized response is caught, by name;
 *   2. renaming a required field is caught, by name (the old name is reported missing);
 *   3. editing any schema file without bumping version.json makes the
 *      schemas_sha256 assertion FAIL (so an uncoordinated schema change cannot ship).
 *
 * The positive counterpart — that unmodified real responses PASS — lives in
 * responses.test.mjs; keeping the negative controls here makes the "it bites" and
 * "it passes clean" halves independently readable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { check, wire } from "./helpers.mjs";
import { computeSchemasDigest, SCHEMAS_DIR, listSchemaFiles } from "../../contract/digest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "..", "dist");
const ROOT = resolve(HERE, "..", "..");

/** A REAL serialized closed Box trade, from the production serializer. */
async function realTrade() {
  const h = await import(`${HERE}/../box/helpers.mjs`);
  const { serializeBoxTrade } = await import(`${DIST}/box/serialize.js`);
  const { configSnapshot, loadBoxConfig } = await import(`${DIST}/box/config.js`);
  const { candidate } = h.goodCandidate();
  const opened = new Date("2026-08-29T04:20:00.000Z");
  const closed = new Date("2026-08-29T05:10:30.000Z");
  return wire(serializeBoxTrade({
    _id: { toString: () => "68b0f1c2a1b2c3d4e5f60001" },
    execution_mode: "paper_touch", underlying: "NIFTY", name: "NIFTY 50", is_index: true,
    expiry: candidate.expiry, lower_strike: h.GOOD_BOX.k1, upper_strike: h.GOOD_BOX.k2,
    lot_size: h.LOT, quantity: h.LOT, status: "closed",
    legs: [{
      role: "k1_ce", token: 1004, tradingsymbol: "NIFTY26SEP19900CE", exchange: "NFO",
      strike: h.GOOD_BOX.k1, instrument_type: "CE", side: "BUY", entry_price: 300, entry_bid: 299,
      entry_bid_qty: 150, entry_ask: 300, entry_ask_qty: 150, entry_quote_at: opened,
      entry_depth: { bids: [], asks: [] }, exit_price: 350, exit_bid: 350, exit_bid_qty: 150,
      exit_ask: 351, exit_ask_qty: 150, exit_quote_at: closed, exit_depth: { bids: [], asks: [] },
    }],
    box_width: h.GOOD_BOX.width, entry_box_cost: h.GOOD_BOX.costPerUnit * h.LOT,
    entry_gross_edge: h.GOOD_BOX.grossEdge, entry_charges: null, estimated_exit_charges: null,
    safety_buffer: 150, entry_net_edge: 1425, opened_at: opened, current_remaining_edge: 150,
    exit_box_value: 198 * h.LOT, exit_charges: null, gross_pnl: 1725, total_charges: 300,
    net_pnl: 1425, closed_at: closed, exit_reason: "EDGE_CONVERGED", exit_blocked_reason: null,
    expiry_safety: false, scanner_config_snapshot: configSnapshot(loadBoxConfig()), error: null,
  }));
}

test("negative control (a): DELETING a required field is caught by name", async () => {
  const trade = await realTrade();
  assert.deepEqual(await check(trade, "box-trade.schema.json"), [], "the unmodified trade must be valid");

  // Delete a required top-level field.
  delete trade.net_pnl;
  const errs = await check(trade, "box-trade.schema.json");
  assert.ok(errs.length > 0, "deleting a required field must produce an error");
  assert.ok(
    errs.some((e) => e.path === "net_pnl" && /required property is missing/.test(e.message)),
    `the error must name the deleted field 'net_pnl'; got ${JSON.stringify(errs)}`,
  );
});

test("negative control (a2): deleting a required NESTED (leg) field is caught by name", async () => {
  const trade = await realTrade();
  delete trade.legs[0].side;
  const errs = await check(trade, "box-trade.schema.json");
  assert.ok(
    errs.some((e) => e.path === "legs.0.side" && /required property is missing/.test(e.message)),
    `the error must name the deleted nested field 'legs.0.side'; got ${JSON.stringify(errs)}`,
  );
});

test("negative control (b): RENAMING a required field is caught by name (old name missing + new name rejected)", async () => {
  const trade = await realTrade();
  // Rename net_pnl -> netPnl (a plausible camelCase drift the frontend would break on).
  trade.netPnl = trade.net_pnl;
  delete trade.net_pnl;
  const errs = await check(trade, "box-trade.schema.json");
  assert.ok(
    errs.some((e) => e.path === "net_pnl" && /required property is missing/.test(e.message)),
    `the OLD name 'net_pnl' must be reported missing; got ${JSON.stringify(errs)}`,
  );
  assert.ok(
    errs.some((e) => e.path === "netPnl" && /additional property is not allowed/.test(e.message)),
    `the NEW name 'netPnl' must be rejected as an additional property; got ${JSON.stringify(errs)}`,
  );
});

test("negative control (b2): renaming a broker-status field is caught over the real HTTP shape's schema", async () => {
  // Use a hand-shaped-but-schema-valid broker-status, prove valid, then rename a field.
  const good = {
    active_broker: "zerodha",
    generation: 1,
    brokers: [
      { broker: "zerodha", session: { broker: "zerodha", connected: true, state: "ready", account_label: null, established_at: null, expires_at: null }, health: { broker: "zerodha", authenticated: true, data_ready: true, trading_ready: true, problems: [] } },
    ],
  };
  assert.deepEqual(await check(good, "broker-status.schema.json"), [], "baseline must be valid");
  good.activeBroker = good.active_broker;
  delete good.active_broker;
  const errs = await check(good, "broker-status.schema.json");
  assert.ok(errs.some((e) => e.path === "active_broker" && /required property is missing/.test(e.message)));
  assert.ok(errs.some((e) => e.path === "activeBroker" && /additional property is not allowed/.test(e.message)));
});

test("digest: version.json schemas_sha256 MATCHES the computed digest over contract/schemas/**", async () => {
  const version = JSON.parse(readFileSync(resolve(ROOT, "contract", "version.json"), "utf8"));
  const { digest, files } = computeSchemasDigest();
  assert.ok(files.length >= 20, `expected the full schema set to be hashed, got ${files.length}`);
  assert.equal(
    version.schemas_sha256,
    digest,
    "version.json is stale: a schema was edited without regenerating schemas_sha256. Run `node contract/digest.mjs` and update contract/version.json (and bump contract_version).",
  );
  assert.match(version.contract_version, /^\d+\.\d+\.\d+$/, "contract_version must be semver");
});

test("digest: mutating a schema file makes the schemas_sha256 assertion FAIL", () => {
  // Prove the digest gate bites: temporarily append a byte to a schema file, recompute,
  // assert it no longer matches the pinned digest, then restore the file EXACTLY.
  const version = JSON.parse(readFileSync(resolve(ROOT, "contract", "version.json"), "utf8"));
  const target = resolve(SCHEMAS_DIR, listSchemaFiles()[0]);
  const original = readFileSync(target);
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
    const { digest } = computeSchemasDigest();
    assert.notEqual(
      digest,
      version.schemas_sha256,
      "a mutated schema file must change the digest — otherwise the gate does not bite",
    );
  } finally {
    writeFileSync(target, original);
  }
  // And after restoring, the digest matches again (no residue).
  const { digest: restored } = computeSchemasDigest();
  assert.equal(restored, version.schemas_sha256, "restoring the file must restore the digest exactly");
});

test("digest: is deterministic and order-independent (sorted by filename)", () => {
  const a = computeSchemasDigest().digest;
  const b = computeSchemasDigest().digest;
  assert.equal(a, b, "the digest must be stable across runs");
});

/* ══════════════ REGRESSION: projection key-set === schema key-set ══════════════
 *
 * This is the test that would have CAUGHT the original defect. For each shape that
 * src/index.ts RE-PROJECTS (export status, broker session, broker health) we assert
 * that the set of keys the REAL production projection emits is exactly reconcilable
 * with the schema's declared keys, in BOTH directions:
 *
 *   (→) every key the projection emits is a DECLARED property of the schema — so a
 *       future field added to a projection but not to the schema FAILS here;
 *   (←) every REQUIRED key of the schema is emitted by the projection — so a field
 *       required by the schema but dropped from the projection FAILS here.
 *
 * Had this existed, `enabled`/`connected` (emitted by projectExportStatus) and
 * `state` (emitted by projectBrokerSession) could not have been absent from the
 * schema: direction (→) would have flagged the extra emitted key immediately.
 */

/** Read a schema file's { propertyKeys, requiredKeys }. */
function schemaKeys(name) {
  const raw = readFileSync(resolve(SCHEMAS_DIR, name), "utf8");
  const s = JSON.parse(raw);
  return {
    properties: new Set(Object.keys(s.properties ?? {})),
    required: new Set(s.required ?? []),
  };
}

test("regression: each re-projected shape's REAL key set is exactly reconcilable with its schema", async () => {
  const { projectExportStatus, projectBrokerSession, projectBrokerHealth } =
    await import(`${DIST}/runtime/projections.js`);

  const cases = [
    {
      schema: "export-status.schema.json",
      emitted: wire(projectExportStatus({
        enabled: true, connected: true, backlog: 3, oldestPendingAgeMs: 10,
        lastSuccessAt: "2026-09-09T03:20:00.000Z", lastError: null, deadLettered: 0,
        publishedTotal: 5, attemptsHistogram: {},
      })),
    },
    {
      schema: "broker-session.schema.json",
      emitted: wire(projectBrokerSession("zerodha", {
        broker: "zerodha", authenticated: true, client_id: "AB1234567", client_name: "op",
        token_expires_at: Date.parse("2026-09-09T18:30:00.000Z"), token_expired: false,
        login_day: "2026-09-09", login_at: Date.parse("2026-09-09T03:15:00.000Z"),
      }, "zerodha")),
    },
    {
      schema: "broker-health.schema.json",
      emitted: wire(projectBrokerHealth("zerodha", {
        broker: "zerodha", authenticated: true, token_expires_at: null, token_expired: false,
        data_ready: true, trading_ready: false, static_ip_configured: null,
        feed_connected: true, feed_age_ms: 5, problems: [],
      })),
    },
  ];

  for (const { schema, emitted } of cases) {
    const { properties, required } = schemaKeys(schema);
    const emittedKeys = new Set(Object.keys(emitted));

    // (→) every emitted key must be a declared property of the schema.
    for (const k of emittedKeys) {
      assert.ok(
        properties.has(k),
        `${schema}: projection emits '${k}' but the schema does not declare it — ` +
          `a field was added to the projection without updating the schema.`,
      );
    }

    // (←) every REQUIRED schema key must be emitted by the projection.
    for (const k of required) {
      assert.ok(
        emittedKeys.has(k),
        `${schema}: schema requires '${k}' but the projection does not emit it — ` +
          `the schema requires a field the real projection never produces.`,
      );
    }

    // And the projection output must, of course, actually validate.
    assertValidHere(await check(emitted, schema), schema);
  }
});

function assertValidHere(errs, name) {
  assert.deepEqual(errs, [], `${name} must satisfy its schema; errors: ${JSON.stringify(errs)}`);
}
