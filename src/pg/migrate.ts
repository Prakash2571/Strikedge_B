/**
 * Checked-in SQL migrations, applied transactionally and exactly once.
 *
 * DESIGN
 *  - Files live in `migrations/NNN_name.sql`, applied in lexical order.
 *  - Each file runs inside its OWN transaction, so a failure leaves the database
 *    at the last complete migration rather than half-way through one.
 *  - A `schema_migrations` row records the filename and the sha256 of its
 *    contents. Re-running is a no-op; EDITING an already-applied file is a hard
 *    error, because two deployments would then disagree about what the schema is
 *    while both believing they were migrated.
 *  - A PostgreSQL advisory lock serialises concurrent starters, so two PM2
 *    processes booting together cannot both apply migration 003.
 *
 * The DDL itself is written to be repeatable (`CREATE TABLE IF NOT EXISTS`,
 * `CREATE INDEX IF NOT EXISTS`), which is what makes a partially-applied file
 * safe to retry after the transaction rolled it back.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolClient } from "pg";
import { boundedError, withClient } from "./pool.js";

/** Advisory-lock key. Arbitrary but fixed: it only has to be unique per database. */
const MIGRATION_LOCK_KEY = 0x5751_4d47; // "SEMG"

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Where the .sql files are. `dist/pg/migrate.js` is two levels below the package
 * root, and the migrations are NOT compiled, so they are resolved relative to the
 * package rather than to `import.meta.url`'s directory.
 */
export function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "migrations");
}

export async function listMigrationFiles(dir = migrationsDir()): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith(".sql")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Apply every pending migration. Returns what it did, so boot can log a single
 * honest line and a test can assert the second call applied nothing.
 */
export async function runMigrations(dir = migrationsDir()): Promise<MigrationResult> {
  const files = await listMigrationFiles(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  await withClient(async (client) => {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    try {
      await ensureMigrationTable(client);
      const known = await loadApplied(client);

      for (const file of files) {
        const sql = await readFile(join(dir, file), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const previous = known.get(file);

        if (previous) {
          if (previous !== checksum) {
            throw new Error(
              `Migration ${file} was modified after it was applied (recorded checksum ${previous.slice(0, 12)}…, file is ${checksum.slice(0, 12)}…). ` +
                `Add a new migration instead of editing an applied one.`,
            );
          }
          skipped.push(file);
          continue;
        }

        try {
          await client.query("BEGIN");
          await client.query(sql);
          await client.query(
            `INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, now())`,
            [file, checksum],
          );
          await client.query("COMMIT");
          applied.push(file);
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw new Error(`Migration ${file} failed: ${boundedError(err, 400)}`);
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  });

  return { applied, skipped };
}

/**
 * Assert the database is fully migrated WITHOUT applying anything.
 *
 * Boot uses this when `PG_MIGRATE_ON_BOOT=false`, so a production deployment can
 * apply schema changes as a deliberate step and still have the process refuse to
 * start against a database that is behind the code.
 */
export async function assertMigrated(dir = migrationsDir()): Promise<void> {
  const files = await listMigrationFiles(dir);
  await withClient(async (client) => {
    await ensureMigrationTable(client);
    const known = await loadApplied(client);
    const pending = files.filter((f) => !known.has(f));
    if (pending.length > 0) {
      throw new Error(
        `PostgreSQL schema is behind the code: ${pending.length} migration(s) pending (${pending.slice(0, 5).join(", ")}${pending.length > 5 ? ", …" : ""}). Run \`npm run migrate\`.`,
      );
    }
  });
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function loadApplied(client: PoolClient): Promise<Map<string, string>> {
  const { rows } = await client.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM schema_migrations`,
  );
  return new Map(rows.map((r) => [r.filename, r.checksum]));
}
