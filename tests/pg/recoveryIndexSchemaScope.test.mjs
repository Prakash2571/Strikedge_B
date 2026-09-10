/**
 * CRASH-RECOVERY INDEX VALIDATION MUST READ **OUR** INDEX, NOT ANY SCHEMA'S.
 *
 * `describeRecoveryIndex()` in src/box/repository.ts reads the crash-recovery partial unique index
 * back out of the PostgreSQL catalog so the pure validator can check it. `pg_index` and `pg_class`
 * are DATABASE-WIDE, so a lookup matching on `relname` alone matches a table of the same name in
 * every schema.
 *
 * That is not a hypothetical. Two concrete failures follow from it:
 *
 *   1. CORRECTNESS. `boxRecoveryPersistenceValidationError` selects its descriptor by index NAME
 *      (`indexes.find`). Given two same-named indexes it takes the FIRST row the catalog returns,
 *      which is ordered by physical position — i.e. by creation order, not by relevance. So a
 *      decoy created earlier is validated INSTEAD of ours, and the guard that exists to prove
 *      "at most one unresolved crash-recovery row can exist" reports on a relation this process
 *      never writes to.
 *   2. ROBUSTNESS. `pg_get_indexdef(oid)` opens the relation when it is called. A row belonging to
 *      a schema that is being dropped concurrently therefore raises
 *      `could not open relation with OID <n>` (SQLSTATE XX000), failing an unrelated startup check.
 *      This reproduced intermittently on PostgreSQL 17.2 whenever the pg suites ran with a
 *      concurrency of 4 or more, each file creating and dropping its own schema.
 *
 * THE TEST. A decoy schema is created FIRST, holding a `box_execution_attempts` table and an index
 * carrying the real index's name but a deliberately WRONG partial filter (`resolved = true`
 * instead of `resolved = false`). Creating it first is what makes the assertion deterministic: the
 * decoy takes the lower OID, so the unscoped query returns it first and `find` picks it. Only then
 * is the real schema created by the migrations.
 *
 * Against the unscoped lookup this test FAILS with
 *   `Box crash-recovery persistence is unsafe: box_single_unresolved_crash_recovery has an
 *    incompatible partial filter`
 * because the decoy's filter is what got validated. Against the `to_regclass`-scoped lookup it
 * passes, because only the current search_path's table is considered.
 *
 * No broker request; PostgreSQL only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { setup, teardown } from "./helpers.mjs";

const { Client } = pg;

const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";
const REAL_INDEX = "box_single_unresolved_crash_recovery";

/** A decoy schema whose index wears the real name but carries the WRONG partial filter. */
async function createDecoySchema() {
  const name = `pgt_decoy_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${name}`);
    // Only the columns the index touches are needed; this table is never written to.
    await admin.query(
      `CREATE TABLE ${name}.box_execution_attempts (
         id text PRIMARY KEY,
         candidate_key text NOT NULL,
         resolved boolean NOT NULL DEFAULT false
       )`,
    );
    // Same NAME as the production index, deliberately WRONG partial filter.
    await admin.query(
      `CREATE UNIQUE INDEX ${REAL_INDEX} ON ${name}.box_execution_attempts (candidate_key)
       WHERE candidate_key = 'boot-recovery' AND resolved = true`,
    );
  } finally {
    await admin.end();
  }
  return name;
}

async function dropSchema(name) {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  } finally {
    await admin.end();
  }
}

test("crash-recovery index validation ignores a same-named index in another schema", async () => {
  // ORDER MATTERS: the decoy is created first so it holds the LOWER OID and the unscoped
  // catalog query would return it ahead of ours.
  const decoy = await createDecoySchema();
  let ctx;
  try {
    ctx = await setup("recoveryscope");
    const repo = await import("../../dist/box/repository.js");

    // Establishing the boundary reads the index back out of the catalog and validates it. With a
    // database-wide lookup this throws, having validated the decoy's wrong partial filter.
    await repo.initialiseBoxExecutionAttemptPersistence();
    assert.equal(
      repo.isBoxRecoveryPersistenceReady(),
      true,
      "our own correct index must be the one validated, not the decoy's",
    );

    // And the boundary still does its real job: a second attempt adopts the same row.
    const residual = [
      { token: 9001, tradingsymbol: "SYM-k1_ce", exchange: "NFO", role: "k1_ce", side: "SELL", quantity: 75 },
    ];
    const first = await repo.ensureBoxRecoveryExecutionAttempt({
      id: repo.allocateBoxTradeId(),
      recoveryKey: repo.BOX_RECOVERY_KEY,
      residual,
      executionMode: "live",
      broker: "zerodha",
      at: new Date(),
    });
    const second = await repo.ensureBoxRecoveryExecutionAttempt({
      id: repo.allocateBoxTradeId(),
      recoveryKey: repo.BOX_RECOVERY_KEY,
      residual,
      executionMode: "live",
      broker: "zerodha",
      at: new Date(),
    });
    assert.equal(first._id, second._id, "exactly one unresolved crash-recovery boundary");
  } finally {
    if (ctx) await teardown(ctx);
    await dropSchema(decoy);
  }
});
