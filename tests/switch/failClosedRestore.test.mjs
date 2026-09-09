/**
 * FAIL-CLOSED RESTORATION OF THE AUTHORITATIVE BROKER SELECTION.
 *
 * THE BUG THESE TESTS PIN DOWN
 * `ActiveBrokerManager.restore()` used to read the authoritative selection as
 *     const saved = await loadActiveBroker().catch(() => null);
 * and `boot()` used to call it as
 *     await brokerManager.restore().catch(err => console.warn(...));
 * so FIVE different situations collapsed into one answer — "there is no durable
 * selection, use DEFAULT_ACTIVE_BROKER at generation 1":
 *
 *   1. PostgreSQL genuinely holds no row      (a real fresh deployment)
 *   2. the query FAILED                       (an outage)
 *   3. the row names an unknown broker        (corruption / a newer build)
 *   4. the row holds an unusable generation   (corruption)
 *   5. the stored Dhan session cannot be read (a wrong BROKER_TOKEN_ENCRYPTION_KEY)
 *
 * Only (1) may use the configured default. In cases 2–5 the process came up on a
 * possibly WRONG VENUE and — worse — at generation 1. Durable instrument reservations
 * are stamped with the generation and refuse to execute when it no longer matches, so a
 * process that restarted to generation 1 after a real generation 37 would treat a
 * predecessor's abandoned reservation as current. Both halves are now fail-closed.
 *
 * FAILS LOUDLY WITHOUT POSTGRESQL — createPgHarness throws at setup. These are
 * integration tests against the REAL compiled dist/ code and REAL PostgreSQL; nothing
 * here contacts a broker, a token provider or any non-loopback host.
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPgHarness, TEST_KEY_HEX } from "../tokens/helpers.mjs";
import { makeManager } from "./helpers.mjs";

/** A DIFFERENT but structurally valid 32-byte key, used to make decryption fail. */
const WRONG_KEY_HEX = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

let h;
let store;

before(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  h = await createPgHarness("failclosed");
  store = await import("../../dist/brokerState/brokerSessions.js");
});
after(async () => {
  if (h) await h.cleanup();
});
beforeEach(async () => {
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = TEST_KEY_HEX;
  const c = await h.raw();
  await c.query(`TRUNCATE active_broker`);
  await c.query(`TRUNCATE broker_sessions`);
  await c.query(`ALTER SEQUENCE active_broker_generation_seq RESTART WITH 1`);
  c.release();
});

/**
 * Drop a CHECK constraint so a corrupt row can be planted.
 *
 * `IF EXISTS` because several tests drop the same constraint and `beforeEach` only
 * truncates rows — the schema change from an earlier test legitimately persists.
 */
async function dropConstraint(name) {
  const c = await h.raw();
  await c.query(`ALTER TABLE active_broker DROP CONSTRAINT IF EXISTS ${name}`);
  c.release();
}

/** Plant a row directly, bypassing saveActiveBroker's own validation. */
async function plantActiveBrokerRow(broker, generation) {
  const c = await h.raw();
  await c.query(
    `INSERT INTO active_broker (id, broker, generation, selected_by) VALUES ('current', $1, $2, 'corrupt')`,
    [broker, generation],
  );
  c.release();
}

/* ========================================================================== */
/*  CASE 1 — A CONFIRMED ABSENCE IS THE ONLY THING THAT MAY USE THE DEFAULT    */
/* ========================================================================== */

test("no active_broker row: PostgreSQL confirms absence, so the configured default is used", async () => {
  const loaded = await store.loadActiveBroker();
  assert.equal(loaded, null, "an empty table must report a CONFIRMED absence, not an error");

  const mgr = await makeManager("dhan");
  assert.equal(mgr.activeBroker, "dhan", "constructed on DEFAULT_ACTIVE_BROKER");
  await mgr.restore();
  assert.equal(
    mgr.activeBroker,
    "dhan",
    "a confirmed-absent row is a fresh deployment: DEFAULT_ACTIVE_BROKER selects the first broker",
  );
  assert.equal(mgr.generation, 1, "a fresh deployment starts at the initial generation");
});

test("no active_broker row and DEFAULT_ACTIVE_BROKER unset: Zerodha remains the default", async () => {
  const mgr = await makeManager(null);
  assert.equal(mgr.activeBroker, "zerodha");
  await mgr.restore();
  assert.equal(mgr.activeBroker, "zerodha", "unset means Zerodha, and restore() must not change that");
});

/* ========================================================================== */
/*  CASE 1b — A DURABLE SELECTION OUTRANKS THE CONFIG DEFAULT, BOTH WAYS       */
/* ========================================================================== */

test("a durable Dhan selection overrides a Zerodha default", async () => {
  await store.saveActiveBroker("dhan", "test-operator");
  const mgr = await makeManager("zerodha");
  assert.equal(mgr.activeBroker, "zerodha");
  await mgr.restore();
  assert.equal(mgr.activeBroker, "dhan", "the operator's durable switch outranks the config default");
});

test("a durable Zerodha selection overrides a Dhan default", async () => {
  await store.saveActiveBroker("zerodha", "test-operator");
  const mgr = await makeManager("dhan");
  assert.equal(mgr.activeBroker, "dhan");
  await mgr.restore();
  assert.equal(
    mgr.activeBroker,
    "zerodha",
    "the override must work in BOTH directions, not just towards Dhan",
  );
});

test("the durable generation is restored, not restarted at 1", async () => {
  // Burn several generations so the durable value is unmistakably not the initial one.
  await store.saveActiveBroker("zerodha", "boot");
  await store.saveActiveBroker("dhan", "op");
  const third = await store.saveActiveBroker("zerodha", "op");
  assert.equal(third.generation, 3);

  const mgr = await makeManager("dhan");
  assert.equal(mgr.generation, 1, "a fresh process object starts at 1 before restoration");
  await mgr.restore();
  assert.equal(mgr.activeBroker, "zerodha");
  assert.equal(
    mgr.generation,
    3,
    "the durable generation must be adopted; restarting the count would make a stale " +
      "predecessor's instrument reservation look current",
  );
});

/* ========================================================================== */
/*  CASE 2 — A FAILED QUERY MUST NEVER LOOK LIKE AN ABSENCE                    */
/* ========================================================================== */

test("an active_broker QUERY FAILURE rejects instead of reporting absence", async () => {
  // Simulate the authority being unreadable: the relation is not there for this query.
  const c = await h.raw();
  await c.query(`ALTER TABLE active_broker RENAME TO active_broker_unavailable`);
  c.release();
  try {
    await assert.rejects(
      () => store.loadActiveBroker(),
      (err) => {
        assert.ok(err instanceof Error, "a query failure must surface as an error");
        return true;
      },
      "a failing query must NOT resolve to null — null means 'confirmed no row'",
    );
  } finally {
    const c2 = await h.raw();
    await c2.query(`ALTER TABLE active_broker_unavailable RENAME TO active_broker`);
    c2.release();
  }
});

test("an active_broker query failure PREVENTS BOOT (restore rejects, default is not adopted)", async () => {
  // A durable Dhan selection exists, but the read will fail. The old code would have
  // silently continued on the Zerodha default — the exact wrong-venue outcome.
  await store.saveActiveBroker("dhan", "test-operator");
  const mgr = await makeManager("zerodha");

  const c = await h.raw();
  await c.query(`ALTER TABLE active_broker RENAME TO active_broker_unavailable`);
  c.release();
  try {
    await assert.rejects(
      () => mgr.restore(),
      /active_broker/i,
      "restore() must reject so boot() fails rather than guessing a broker",
    );
  } finally {
    const c2 = await h.raw();
    await c2.query(`ALTER TABLE active_broker_unavailable RENAME TO active_broker`);
    c2.release();
  }
  assert.equal(
    mgr.activeBroker,
    "zerodha",
    "the manager is left on its unrestored default — which is precisely why the " +
      "rejection must kill boot instead of being logged and ignored",
  );
});

/* ========================================================================== */
/*  CASES 3 + 4 — A PRESENT-BUT-INVALID ROW MUST FAIL CLOSED                   */
/* ========================================================================== */

test("an INVALID durable broker prevents boot with a bounded, non-secret error", async () => {
  // The shipped schema has a CHECK constraint, so corruption of this kind can only be
  // produced by dropping it — which is exactly what a hand-edited row or a row written
  // by a build that knew a third broker would look like to this process.
  await dropConstraint("active_broker_valid");
  await plantActiveBrokerRow("etrade", 7);

  await assert.rejects(
    () => store.loadActiveBroker(),
    (err) => {
      assert.equal(err.name, "DurableStateError");
      assert.equal(err.code, "active_broker_invalid_broker");
      assert.match(err.message, /unknown broker "etrade"/);
      assert.ok(err.message.length <= 200, `the error must stay bounded, got ${err.message.length} chars`);
      assert.doesNotMatch(err.message, /SELECT|INSERT|password|token/i, "no SQL or secret in the message");
      return true;
    },
  );

  const mgr = await makeManager("zerodha");
  await assert.rejects(() => mgr.restore(), /unknown broker/i, "restore() must fail closed");
});

test("an EMPTY durable broker value prevents boot", async () => {
  await dropConstraint("active_broker_valid");
  await plantActiveBrokerRow("   ", 4);

  await assert.rejects(() => store.loadActiveBroker(), (err) => {
    assert.equal(err.code, "active_broker_missing_broker");
    return true;
  });
});

test("an INVALID durable generation prevents boot (non-positive)", async () => {
  await dropConstraint("active_broker_generation_positive");
  await plantActiveBrokerRow("dhan", 0);

  await assert.rejects(
    () => store.loadActiveBroker(),
    (err) => {
      assert.equal(err.name, "DurableStateError");
      assert.equal(err.code, "active_broker_invalid_generation");
      assert.ok(err.message.length <= 200, "bounded error");
      return true;
    },
  );

  const mgr = await makeManager("zerodha");
  await assert.rejects(() => mgr.restore(), /generation/i, "restore() must fail closed, not coerce to 1");
});

test("a durable generation beyond exact integer precision prevents boot rather than rounding", async () => {
  // bigint accepts this and it satisfies `generation > 0`, so the positivity constraint
  // does not have to be dropped. Number() would silently round it, and a rounded
  // generation compared against a reservation's stamp is a false match. Refuse it.
  await plantActiveBrokerRow("dhan", "9223372036854775807");

  await assert.rejects(() => store.loadActiveBroker(), (err) => {
    assert.equal(err.code, "active_broker_invalid_generation");
    return true;
  });
});

/* ========================================================================== */
/*  CASE 5 — A DHAN-SESSION READ/DECRYPT FAILURE IS NOT AN ABSENCE             */
/* ========================================================================== */

test("a Dhan-session DECRYPTION failure is not treated as 'Dhan is not connected'", async () => {
  await store.saveDhanSession({
    access_token: "fake-dhan-token-for-tests-only",
    dhan_client_id: "1000000001",
    dhan_client_name: "Test",
    dhan_client_ucc: "TESTUCC",
    given_power_of_attorney: false,
    expiry_time: Date.now() + 6 * 60 * 60 * 1000,
    login_date: "2026-09-08",
  });

  // The operator rotated/lost the key. The row is fine; we simply cannot read it.
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = WRONG_KEY_HEX;

  const mgr = await makeManager("dhan");
  await assert.rejects(
    () => mgr.adoptStoredDhanSession(),
    (err) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(
        err.message,
        /fake-dhan-token-for-tests-only/,
        "no plaintext token may appear in the error",
      );
      return true;
    },
    "adoptStoredDhanSession() must REJECT, not return false — false means 'nothing stored'",
  );
});

test("a Dhan-session decryption failure PREVENTS BOOT via restore()", async () => {
  await store.saveActiveBroker("dhan", "test-operator");
  await store.saveDhanSession({
    access_token: "fake-dhan-token-for-tests-only",
    dhan_client_id: "1000000001",
    dhan_client_name: "Test",
    dhan_client_ucc: "TESTUCC",
    given_power_of_attorney: false,
    expiry_time: Date.now() + 6 * 60 * 60 * 1000,
    login_date: "2026-09-08",
  });
  process.env.BROKER_TOKEN_ENCRYPTION_KEY = WRONG_KEY_HEX;

  const mgr = await makeManager("dhan");
  await assert.rejects(() => mgr.restore(), (err) => {
    assert.doesNotMatch(err.message, /fake-dhan-token-for-tests-only/);
    return true;
  });
});

test("a broker_sessions QUERY failure is not treated as an absent Dhan session", async () => {
  const c = await h.raw();
  await c.query(`ALTER TABLE broker_sessions RENAME TO broker_sessions_unavailable`);
  c.release();
  try {
    const mgr = await makeManager("dhan");
    await assert.rejects(
      () => mgr.adoptStoredDhanSession(),
      /broker_sessions/i,
      "a failing query must not resolve false",
    );
  } finally {
    const c2 = await h.raw();
    await c2.query(`ALTER TABLE broker_sessions_unavailable RENAME TO broker_sessions`);
    c2.release();
  }
});

test("a CONFIRMED ABSENT Dhan session still resolves false (the normal answer must keep working)", async () => {
  const mgr = await makeManager("zerodha");
  assert.equal(
    await mgr.adoptStoredDhanSession(),
    false,
    "no stored Dhan row is a legitimate 'not connected', and must not throw",
  );
});

/* ========================================================================== */
/*  NO SCANNER / FEED / ENTRY PATH MAY START AFTER A RESTORATION FAILURE       */
/* ========================================================================== */

test("restore() is awaited UNGUARDED in boot(), before anything that can trade", () => {
  const src = readFileSync(new URL("../../dist/index.js", import.meta.url), "utf8");

  const restoreAt = src.indexOf("brokerManager.restore()");
  assert.ok(restoreAt > 0, "boot() must call brokerManager.restore()");

  // No `.catch(...)` may be chained onto the restore call. A catch here is precisely the
  // defect: it converts a wrong-venue boot into a log line.
  const tail = src.slice(restoreAt, restoreAt + 120);
  assert.doesNotMatch(
    tail,
    /brokerManager\.restore\(\)\s*\.catch/,
    "brokerManager.restore() must NOT be .catch()-ed; the rejection must fail boot",
  );

  // And it must be sequenced BEFORE every path that can price, subscribe or trade.
  for (const later of ["boxModule.boot()", "tokenService.start()", "projector.start()"]) {
    const at = src.indexOf(later);
    assert.ok(at > 0, `boot() must still call ${later}`);
    assert.ok(
      restoreAt < at,
      `restore() must be awaited BEFORE ${later}, so a restoration failure stops the boot ` +
        "sequence before a feed, a scanner or an entry path can exist",
    );
  }
});

test("boot() never starts the scanner or arms live entry", () => {
  const src = readFileSync(new URL("../../dist/index.js", import.meta.url), "utf8");
  const bootStart = src.indexOf("async function boot()");
  assert.ok(bootStart > 0);
  const bootEnd = src.indexOf("let sessionSweeperStop", bootStart);
  assert.ok(bootEnd > bootStart, "could not bound the boot() body");

  // Strip comments FIRST. boot() documents its own restraint ("Deliberately absent: no
  // engine.start(), no live arming"), and a scan that matched that sentence would pass
  // or fail on prose rather than on executable code.
  const bootBody = src
    .slice(bootStart, bootEnd)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  assert.doesNotMatch(bootBody, /engine\.start\(/, "boot() must never start scanner discovery");
  assert.doesNotMatch(bootBody, /\.arm\(|armLive|setLiveArmed/, "boot() must never arm live entry");
  // Positive control: the stripping must not have emptied the body.
  assert.match(bootBody, /await boxModule\.boot\(\)/, "the comment-stripped body must still contain real code");
});
