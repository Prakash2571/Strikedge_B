/**
 * Outbox WRITER — the half of the projection pipeline that runs inside the
 * operational transaction.
 *
 * Every repository mutation that needs a MongoDB Atlas projection calls
 * `enqueueOutbox(client, …)` on the SAME `PoolClient` that is doing the
 * operational write. There is no separate connection and no `await` on Mongo, so:
 *
 *   * the projection intent commits atomically with the fact it describes;
 *   * a Mongo outage cannot fail, delay or block an order-intent transition,
 *     an exit, a protective cancel, a reconciliation or a residual flatten;
 *   * a crash after COMMIT but before the Mongo write is recovered on restart
 *     purely by reading unpublished rows.
 *
 * SECRET REDACTION IS ENFORCED HERE, NOT DOCUMENTED HERE.
 * The projector is downstream of this function, so this is the only place that can
 * guarantee a secret never reaches the outbox in the first place. Any payload
 * carrying a key on the deny list throws — loudly, at the write, in the caller's
 * transaction — rather than being silently stripped. Silently stripping would let
 * a future refactor quietly stop projecting a field it thought it was projecting.
 */

import type { PoolClient } from "pg";

/** Aggregate families that may be projected. Anything else is a programming error. */
export const OUTBOX_AGGREGATES = [
  "box_trade",
  "box_trade_event",
  "box_order_intent",
  "box_execution_attempt",
  "box_daily_pnl",
  "box_calibration_sample",
] as const;

export type OutboxAggregate = (typeof OUTBOX_AGGREGATES)[number];

export interface OutboxEvent {
  /**
   * Stable, caller-chosen identity. It becomes the Mongo `_id`, so it must be
   * derived from durable facts (trade id + transition, audit id, day + trade id)
   * and never from a clock or a random value — otherwise a retry would create a
   * second document instead of upserting the first.
   */
  eventId: string;
  aggregateType: OutboxAggregate;
  aggregateId: string;
  eventType: string;
  schemaVersion?: number;
  payload: Record<string, unknown>;
}

/**
 * Field names that must never appear anywhere in a projected payload, at any
 * depth. Compared case-insensitively against object keys.
 *
 * This is a deny list of NAMES rather than a value scan on purpose: a value scan
 * cannot recognise a token it has never seen, whereas the writer always knows what
 * a field is called.
 */
const FORBIDDEN_KEYS = new Set(
  [
    "access_token",
    "accesstoken",
    "refresh_token",
    "request_token",
    "api_secret",
    "apisecret",
    "encrypted_access_token",
    "encryption_iv",
    "encryption_auth_tag",
    "session_token",
    "session_token_hash",
    "csrf_secret",
    "passcode",
    "site_access_secret",
    "token_passcode",
    "password",
    "database_url",
    "mongodb_uri",
    "connection_string",
    "broker_token_encryption_key",
  ].map((k) => k.toLowerCase()),
);

export class OutboxSecretLeakError extends Error {
  constructor(path: string) {
    super(
      `Refusing to enqueue a Mongo projection carrying a secret-bearing field at "${path}". ` +
        `Broker tokens, access-session tokens, passcodes, CSRF secrets and database credentials are never projected.`,
    );
    this.name = "OutboxSecretLeakError";
  }
}

/**
 * Walk the payload and throw on the first forbidden key.
 *
 * Exported because the projector tests assert the guard directly, and because the
 * legacy import command reuses it before writing anything it read from an old
 * Mongo database.
 */
export function assertNoSecretFields(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretFields(v, `${path}[${i}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new OutboxSecretLeakError(`${path}.${key}`);
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

/**
 * Enqueue one projection event on an EXISTING transaction.
 *
 * `ON CONFLICT (event_id) DO NOTHING` makes the enqueue itself idempotent, which
 * is what lets a retried operational transaction (a CAS that lost and was retried,
 * an idempotent audit replay) re-run without producing two projection rows.
 */
export async function enqueueOutbox(client: PoolClient, event: OutboxEvent): Promise<void> {
  assertNoSecretFields(event.payload);
  await client.query(
    `INSERT INTO mongo_outbox
       (event_id, aggregate_type, aggregate_id, event_type, schema_version, sequence, payload)
     VALUES ($1, $2, $3, $4, $5, nextval('mongo_outbox_sequence_seq'), $6::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.schemaVersion ?? 1,
      JSON.stringify(event.payload),
    ],
  );
}

/**
 * Enqueue a SNAPSHOT projection: one Mongo document per aggregate, latest value wins.
 *
 * WHY THIS EXISTS SEPARATELY FROM `enqueueOutbox`
 * `enqueueOutbox` is for EVENTS — immutable facts that happened once, whose `eventId`
 * therefore never repeats and whose enqueue is `ON CONFLICT DO NOTHING`.
 *
 * A daily P&L row is not an event. It is a mutable snapshot rewritten many times a day as
 * a position's net P&L moves, and the reporting replica should hold ONE document per
 * (day, trade_id) carrying the latest figures. With a stable `eventId` and DO NOTHING, the
 * first write would project and every subsequent update would be silently dropped — the
 * reporting replica would freeze at the first value it ever saw. With a time-varying
 * `eventId` it would instead accumulate a new Mongo document per update, which is worse.
 *
 * So this keeps the `eventId` stable (it becomes the Mongo `_id`, giving exactly one
 * document per aggregate) and REVIVES the pending row on conflict: the payload is
 * replaced, `published_at` is cleared, the attempt counters are reset and a fresh sequence
 * is taken so ordering still advances.
 *
 * A useful side effect: many intraday updates to the same row COLLAPSE into one pending
 * outbox row, so a Mongo outage cannot make the backlog grow without bound just because
 * P&L is being recalculated on a timer.
 *
 * Clearing `dead_lettered_at` is deliberate. A snapshot that previously exhausted its
 * attempts is superseded by a newer value, and refusing to retry the newer one would leave
 * the replica permanently stale for that row.
 */
export async function enqueueOutboxSnapshot(
  client: PoolClient,
  event: OutboxEvent,
): Promise<void> {
  assertNoSecretFields(event.payload);
  await client.query(
    `INSERT INTO mongo_outbox
       (event_id, aggregate_type, aggregate_id, event_type, schema_version, sequence, payload)
     VALUES ($1, $2, $3, $4, $5, nextval('mongo_outbox_sequence_seq'), $6::jsonb)
     ON CONFLICT (event_id) DO UPDATE SET
       payload          = EXCLUDED.payload,
       event_type       = EXCLUDED.event_type,
       schema_version   = EXCLUDED.schema_version,
       sequence         = nextval('mongo_outbox_sequence_seq'),
       published_at     = NULL,
       attempts         = 0,
       next_attempt_at  = clock_timestamp(),
       last_error       = NULL,
       dead_lettered_at = NULL`,
    [
      event.eventId,
      event.aggregateType,
      event.aggregateId,
      event.eventType,
      event.schemaVersion ?? 1,
      JSON.stringify(event.payload),
    ],
  );
}

/**
 * Enqueue several events in one statement, preserving their relative order.
 *
 * Used where one operational transaction produces a small fixed set of projections
 * (a trade close writes the trade, its event and its P&L row), so the ordering the
 * projector later honours is established at insert time.
 */
export async function enqueueOutboxBatch(
  client: PoolClient,
  events: readonly OutboxEvent[],
): Promise<void> {
  for (const event of events) await enqueueOutbox(client, event);
}
