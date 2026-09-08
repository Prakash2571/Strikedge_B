/**
 * The PROJECTOR — the background loop that drains `mongo_outbox` into MongoDB Atlas.
 *
 * It is the reader half of the transactional outbox. The writer (`enqueueOutbox`,
 * `src/outbox/writer.ts`) inserts a projection row inside the SAME PostgreSQL
 * transaction as the operational fact it describes. This loop, running entirely
 * independently, later publishes those rows to Atlas. Because the two share only
 * the `mongo_outbox` table:
 *
 *   * a Mongo outage can never fail, delay or block an operational transaction —
 *     the enqueue is a local INSERT and this loop is the only thing that awaits
 *     Mongo;
 *   * a crash after PostgreSQL COMMIT but before the Mongo write is recovered on
 *     restart purely by re-reading unpublished rows — no in-memory queue is ever
 *     the source of truth.
 *
 * GUARANTEES THIS LOOP UPHOLDS
 *  1. IDEMPOTENT DELIVERY. Each row is written to Mongo with the row's `event_id`
 *     as the document `_id` via `replaceOne(..., { upsert: true })`. A redelivery
 *     (crash between Mongo write and PostgreSQL mark-published, or a hand replay)
 *     overwrites the same document instead of creating a second trade event or
 *     doubling a P&L figure.
 *  2. PER-AGGREGATE ORDERING. `FOR UPDATE SKIP LOCKED` alone does not order work.
 *     The claimed batch is grouped by (aggregate_type, aggregate_id) and each
 *     group is applied strictly in `sequence` order; the FIRST failure in a group
 *     STOPS that group, so a trade's CLOSED projection can never land before its
 *     OPENED projection. Unrelated aggregates in the same batch still publish.
 *  3. BOUNDED, SECRET-FREE ERRORS with capped exponential backoff, and a dead
 *     letter after an attempt budget — visible in diagnostics, replayable by hand,
 *     never deleted, never blocking the rows behind it.
 *  4. The loop NEVER throws out of `runOnce`, NEVER runs two iterations at once,
 *     and clears its timer on `stop()`.
 */

import type { Pool, PoolClient } from "pg";
import { assertNoSecretFields } from "./writer.js";
import type { MongoExportClient } from "./mongo.js";
import { collectionForAggregate } from "./mongo.js";
import { setProjectorRuntimeState } from "./status.js";

/** One claimed outbox row, minus nothing the projector needs. */
interface OutboxRow {
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  sequence: number;
  payload: Record<string, unknown>;
  attempts: number;
}

/** The Mongo document shape written per row. `_id` is the outbox `event_id`. */
export interface ProjectionDocument {
  _id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  sequence: number;
  /** The projected domain payload, exactly as enqueued (already secret-screened). */
  data: Record<string, unknown>;
  /** When the projector wrote this document. Reporting-only. */
  projected_at: Date;
}

export interface ProjectorConfig {
  batchSize: number;
  intervalMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
}

/** Result of one drain pass, returned so tests and boot can assert progress. */
export interface DrainResult {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

/** Bound an error string: single line, <=500 chars, never SQL text or a payload. */
export function boundedProjectorError(err: unknown, max = 500): string {
  const raw =
    err instanceof Error ? err.message : typeof err === "string" ? err : "unknown projection error";
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Capped exponential backoff: base 2^attempts seconds, clamped to maxBackoffMs. */
export function backoffMs(attempts: number, maxBackoffMs: number): number {
  const base = 1_000; // 1s
  const raw = base * 2 ** Math.min(attempts, 30);
  return Math.min(raw, maxBackoffMs);
}

export class Projector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly pool: Pool,
    private readonly mongo: MongoExportClient,
    private readonly cfg: ProjectorConfig,
  ) {}

  /** Start the periodic loop. Idempotent; a second call is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const tick = (): void => {
      // `runOnce` never rejects, but guard anyway so a bug cannot kill the timer.
      void this.runOnce().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.cfg.intervalMs);
      });
    };
    this.timer = setTimeout(tick, this.cfg.intervalMs);
  }

  /** Stop the loop and clear the timer. Idempotent. Does not close the Mongo client. */
  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run exactly one drain pass. NEVER throws and NEVER overlaps a previous pass
   * (if the previous pass is still in flight, this call returns an empty result).
   */
  async runOnce(): Promise<DrainResult> {
    const empty: DrainResult = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };
    if (this.draining) return empty;
    this.draining = true;
    try {
      return await this.drainBatch();
    } catch (err) {
      // The whole point: a Mongo/claim failure records itself and is retried next
      // tick. It must not escape the loop.
      setProjectorRuntimeState({
        connected: this.mongo.isConnected(),
        lastError: boundedProjectorError(err),
      });
      return empty;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Claim a batch under a single transaction, publish each aggregate group in
   * order, then mark/retry/dead-letter per row. The claim transaction is held for
   * the whole pass so `FOR UPDATE SKIP LOCKED` keeps the rows invisible to any
   * second drainer (there is only one in-process, but this is correct under
   * multiple processes too).
   */
  private async drainBatch(): Promise<DrainResult> {
    const result: DrainResult = { claimed: 0, published: 0, failed: 0, deadLettered: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await this.claim(client);
      result.claimed = rows.length;
      if (rows.length === 0) {
        await client.query("COMMIT");
        // Reflect connection state even on an empty pass so status is fresh.
        setProjectorRuntimeState({ connected: this.mongo.isConnected() });
        return result;
      }

      const groups = groupByAggregate(rows);
      let sawSuccess = false;

      for (const group of groups) {
        for (const row of group) {
          const outcome = await this.publishRow(client, row);
          if (outcome === "published") {
            result.published += 1;
            sawSuccess = true;
          } else {
            // First failure in this aggregate STOPS the group: the remaining
            // events for this aggregate keep their place and wait for the retry,
            // so ordering per aggregate is preserved.
            if (outcome === "dead_lettered") result.deadLettered += 1;
            else result.failed += 1;
            break;
          }
        }
      }

      await client.query("COMMIT");

      setProjectorRuntimeState({
        connected: this.mongo.isConnected(),
        ...(sawSuccess ? { lastSuccessAt: new Date(), lastError: null } : {}),
      });
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** The claim query from the spec: due, unpublished, not dead-lettered, oldest first. */
  private async claim(client: PoolClient): Promise<OutboxRow[]> {
    const { rows } = await client.query<OutboxRow>(
      `SELECT event_id, aggregate_type, aggregate_id, event_type, schema_version, sequence, payload, attempts
         FROM mongo_outbox
        WHERE published_at IS NULL
          AND dead_lettered_at IS NULL
          AND next_attempt_at <= clock_timestamp()
        ORDER BY sequence
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [this.cfg.batchSize],
    );
    return rows;
  }

  /**
   * Publish one row to Mongo and mark it, or record a failure/dead-letter.
   * Returns which happened so the caller can stop the aggregate group on failure.
   */
  private async publishRow(
    client: PoolClient,
    row: OutboxRow,
  ): Promise<"published" | "retry" | "dead_lettered"> {
    try {
      const collectionName = collectionForAggregate(row.aggregate_type);
      if (!collectionName) {
        // A row we cannot route is poison: dead-letter it immediately rather than
        // retrying forever. It stays visible and hand-replayable.
        throw new UnroutableAggregateError(row.aggregate_type);
      }

      // SECOND LINE OF DEFENCE. The writer already screened this payload, but a row
      // that somehow reached the table with a secret is still refused at the Mongo
      // boundary. `assertNoSecretFields` throws on the first forbidden key.
      assertNoSecretFields(row.payload);

      const doc: ProjectionDocument = {
        _id: row.event_id,
        aggregate_type: row.aggregate_type,
        aggregate_id: row.aggregate_id,
        event_type: row.event_type,
        schema_version: row.schema_version,
        sequence: row.sequence,
        data: row.payload,
        projected_at: new Date(),
      };

      const collection = await this.mongo.collection<ProjectionDocument>(collectionName);
      // IDEMPOTENT: `_id` is the event_id, so a redelivery replaces the same
      // document. `replaceOne` with upsert gives exactly-once *effect* even under
      // at-least-once delivery.
      await collection.replaceOne({ _id: row.event_id }, doc, { upsert: true });

      await client.query(
        `UPDATE mongo_outbox
            SET published_at = clock_timestamp(),
                last_error = NULL
          WHERE event_id = $1`,
        [row.event_id],
      );
      return "published";
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const bounded = boundedProjectorError(err);
      // A payload that trips the secret guard, or a row we cannot route, is poison:
      // never deliverable, so dead-letter it now rather than burning the budget.
      const poison = isPoison(err);
      const budgetExhausted = nextAttempts >= this.cfg.maxAttempts;

      if (poison || budgetExhausted) {
        await client.query(
          `UPDATE mongo_outbox
              SET attempts = $2,
                  last_error = $3,
                  dead_lettered_at = clock_timestamp()
            WHERE event_id = $1`,
          [row.event_id, nextAttempts, bounded],
        );
        setProjectorRuntimeState({ connected: this.mongo.isConnected(), lastError: bounded });
        return "dead_lettered";
      }

      const delay = backoffMs(nextAttempts, this.cfg.maxBackoffMs);
      await client.query(
        `UPDATE mongo_outbox
            SET attempts = $2,
                last_error = $3,
                next_attempt_at = clock_timestamp() + ($4::bigint * interval '1 millisecond')
          WHERE event_id = $1`,
        [row.event_id, nextAttempts, bounded, delay],
      );
      setProjectorRuntimeState({ connected: this.mongo.isConnected(), lastError: bounded });
      return "retry";
    }
  }
}

/** A row whose aggregate_type maps to no collection — permanently undeliverable. */
export class UnroutableAggregateError extends Error {
  constructor(aggregateType: string) {
    super(`No projection collection for aggregate_type "${aggregateType}"`);
    this.name = "UnroutableAggregateError";
  }
}

/**
 * A row is POISON — permanently undeliverable — when it cannot be routed to a
 * collection or when its payload trips the secret-boundary guard. Poison rows are
 * dead-lettered immediately rather than burning the retry budget, because no number
 * of retries will ever make them deliverable.
 */
function isPoison(err: unknown): boolean {
  if (err instanceof UnroutableAggregateError) return true;
  // Recognise the writer's OutboxSecretLeakError by NAME, avoiding a class import.
  return err instanceof Error && err.name === "OutboxSecretLeakError";
}

/**
 * Group claimed rows by (aggregate_type, aggregate_id), each group ordered by
 * `sequence`. Groups preserve first-seen order so the overall pass stays roughly
 * FIFO across aggregates while being strictly ordered within one.
 */
export function groupByAggregate(rows: OutboxRow[]): OutboxRow[][] {
  const groups = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    const key = `${row.aggregate_type}\u0000${row.aggregate_id}`;
    const g = groups.get(key);
    if (g) g.push(row);
    else groups.set(key, [row]);
  }
  const out: OutboxRow[][] = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
    out.push(g);
  }
  return out;
}
