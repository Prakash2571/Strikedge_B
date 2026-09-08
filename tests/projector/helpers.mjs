/**
 * Shared fixtures for the projector tests.
 *
 * Plain ESM JavaScript against the COMPILED output in dist/, matching the box
 * suite. Each test FILE gets a uniquely named PostgreSQL SCHEMA and a uniquely
 * named MongoDB DATABASE, so files run in any order without colliding.
 *
 * FAIL LOUDLY. If PostgreSQL or MongoDB is missing these helpers throw at setup —
 * the projector tests are integration tests and must never silently skip.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import { MongoClient } from "mongodb";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://strikedge:strikedge@127.0.0.1:55432/strikedge";
const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://127.0.0.1:57017/strikedge_test";

/** The mongo_outbox DDL, inlined so a test schema can be created without the migration runner. */
const OUTBOX_DDL = `
CREATE TABLE mongo_outbox (
  event_id        text        PRIMARY KEY,
  aggregate_type  text        NOT NULL,
  aggregate_id    text        NOT NULL,
  event_type      text        NOT NULL,
  schema_version  integer     NOT NULL DEFAULT 1,
  sequence        bigint      NOT NULL,
  payload         jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at    timestamptz,
  last_error      text,
  dead_lettered_at timestamptz,
  CONSTRAINT mongo_outbox_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT mongo_outbox_sequence_positive CHECK (sequence > 0),
  CONSTRAINT mongo_outbox_last_error_bounded CHECK (last_error IS NULL OR length(last_error) <= 500)
);
CREATE SEQUENCE mongo_outbox_sequence_seq AS bigint START 1;
CREATE INDEX mongo_outbox_pending_idx ON mongo_outbox (next_attempt_at, sequence)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;
CREATE INDEX mongo_outbox_aggregate_idx ON mongo_outbox (aggregate_type, aggregate_id, sequence);
CREATE INDEX mongo_outbox_dead_letter_idx ON mongo_outbox (dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;
`;

/**
/**
 * Replace the database path in a mongodb connection string, preserving any query
 * string (Atlas SRV options etc.).
 */
function replaceMongoDb(uri, dbName) {
  const [beforeQuery, query] = uri.split("?");
  const withoutDb = beforeQuery.replace(/\/[^/]*$/, "");
  const rebuilt = `${withoutDb}/${dbName}`;
  return query ? `${rebuilt}?${query}` : rebuilt;
}

/**
 * Build a per-file harness: a dedicated PG schema (search_path pinned on the pool)
 * and a dedicated Mongo database. Throws loudly if either service is unreachable.
 */
export async function createHarness(label = "projector") {
  const suffix = `${label}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const schema = `t_${suffix}`;
  const mongoDb = `test_${suffix}`;

  // --- PostgreSQL: create a schema and pin search_path on every connection. ---
  let pool;
  try {
    // Register numeric/int8 parsers so counts come back as numbers (mirrors pool.ts).
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

    // Create the schema on a throwaway connection first.
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 });
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await bootstrap.end().catch(() => undefined);

    // The working pool pins search_path for EVERY physical connection via libpq
    // `options`, so pooled reconnects inherit it deterministically.
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 6,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    });
    await pool.query(OUTBOX_DDL);
  } catch (err) {
    if (pool) await pool.end().catch(() => undefined);
    throw new Error(
      `PostgreSQL is required for the projector tests and is not reachable at ${DATABASE_URL}: ${
        err && err.message ? err.message : err
      }`,
    );
  }

  // --- MongoDB: a dedicated database, verified with a ping. ---
  // Swap whatever db path the base URI carries for this file's unique db name,
  // preserving any query string.
  const mongoUri = replaceMongoDb(MONGODB_URI, mongoDb);

  let verifyClient;
  try {
    verifyClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
    await verifyClient.connect();
    await verifyClient.db(mongoDb).command({ ping: 1 });
  } catch (err) {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw new Error(
      `MongoDB is required for the projector tests and is not reachable at ${MONGODB_URI}: ${
        err && err.message ? err.message : err
      }`,
    );
  } finally {
    if (verifyClient) await verifyClient.close().catch(() => undefined);
  }

  return {
    pool,
    schema,
    mongoDb,
    mongoUri,
    /** A config object for MongoExportClient/Projector using this file's Mongo db. */
    exportConfig(overrides = {}) {
      return {
        enabled: true,
        uri: mongoUri,
        dbName: mongoDb,
        batchSize: 100,
        intervalMs: 50,
        maxBackoffMs: 60_000,
        serverSelectionTimeoutMs: 3_000,
        maxAttempts: 5,
        ...overrides,
      };
    },
    async cleanup() {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await pool.end().catch(() => undefined);
      const drop = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
      try {
        await drop.connect();
        await drop.db(mongoDb).dropDatabase();
      } catch {
        /* best effort */
      } finally {
        await drop.close().catch(() => undefined);
      }
    },
  };
}

/**
 * Insert an outbox row directly (mirrors enqueueOutbox but without importing the
 * writer's transaction contract — tests own their own client/tx). Returns event_id.
 */
export async function enqueueRow(pool, { eventId, aggregateType, aggregateId, eventType, payload, schemaVersion = 1 }) {
  await pool.query(
    `INSERT INTO mongo_outbox (event_id, aggregate_type, aggregate_id, event_type, schema_version, sequence, payload)
     VALUES ($1,$2,$3,$4,$5,nextval('mongo_outbox_sequence_seq'),$6::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, aggregateType, aggregateId, eventType, schemaVersion, JSON.stringify(payload)],
  );
  return eventId;
}

/** Count documents in a Mongo collection for this harness. */
export async function countDocs(mongoUri, mongoDb, collection) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    return await client.db(mongoDb).collection(collection).countDocuments();
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Fetch one Mongo doc by _id. */
export async function findDoc(mongoUri, mongoDb, collection, id) {
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    return await client.db(mongoDb).collection(collection).findOne({ _id: id });
  } finally {
    await client.close().catch(() => undefined);
  }
}
