/**
 * THE POSTGRESQL RESERVATION PORT — the durable correctness authority.
 *
 * This replaces `mongoStore.ts`. It implements the SAME `DurableReservationPort`
 * that `durable.ts` consumes, so the reservation ALGORITHM (all-or-none acquisition,
 * logical expiry, owner-verified release, monotonic fencing, clock-skew handling) is
 * unchanged; only the authority moved from Mongo to PostgreSQL.
 *
 * HOW ALL-OR-NONE IS EXPRESSED
 * Mongo used a UNIQUE MULTIKEY index over `(deployment, keys)`: one index entry per
 * array element. PostgreSQL has no multikey array index, so the set is NORMALISED:
 *   box_reservation_owners  one row per reservation (owner = PK)
 *   box_reservation_keys    one row per canonical instrument key,
 *                           UNIQUE(deployment_id, broker, instrument_key)
 * `insert` writes the owner row and every key row in ONE transaction. The first key
 * that is already claimed raises a unique violation and rolls the WHOLE insert back,
 * so four contracts are claimed together or not at all — the exact guarantee the port
 * docblock says `insert` must keep.
 *
 * TIME COMES FROM THE AUTHORITY, NOT THE NODE CLOCK
 * `serverTimeMs()` returns `clock_timestamp()` from PostgreSQL, so every worker
 * derives expiry from ONE clock and worker-to-worker skew cannot produce two owners.
 *
 * FENCES COME FROM A REAL SEQUENCE
 * `nextFence()` returns `nextval('box_reservation_fence_seq')` — a genuine atomic
 * increment against shared state, monotonic forever. Never a timestamp: a token that
 * can repeat or go backwards cannot identify a stale owner.
 *
 * AN ADVISORY LOCK IS NEVER THE RESERVATION RECORD. The rows above are the record.
 */

import type { PoolClient } from "pg";
import { getPool, isPgReady, isUniqueViolation, withClient, withTx } from "../../pg/pool.js";
import type {
  DurableReservationDoc,
  DurableReservationPort,
  InsertReservationResult,
} from "./port.js";

/** Names kept for parity with the old Mongo adapter's diagnostics/tests. */
export const RESERVATION_UNIQUE_INDEX = "box_reservation_keys_pkey";
export const RESERVATION_TTL_INDEX = "box_reservation_owners_expires_at";
export const RESERVATION_SCOPE_INDEX = "box_reservation_owners_scope";

interface OwnerRow {
  owner: string;
  deployment: string;
  broker: string;
  generation: number;
  mode: string;
  fence: number;
  instance: string;
  created_at: Date;
  expires_at: Date;
  renewed_at: Date;
}

interface KeyRow {
  instrument_key: string;
  side: string;
}

async function loadKeys(client: PoolClient, owner: string): Promise<KeyRow[]> {
  const { rows } = await client.query<KeyRow>(
    `SELECT instrument_key, side FROM box_reservation_keys WHERE owner = $1 ORDER BY instrument_key`,
    [owner],
  );
  return rows;
}

function toDoc(row: OwnerRow, keys: KeyRow[]): DurableReservationDoc {
  return {
    owner: row.owner,
    deployment: row.deployment,
    broker: row.broker,
    generation: Number(row.generation),
    mode: row.mode ?? "",
    keys: keys.map((k) => k.instrument_key),
    sides: keys.map((k) => ({ key: k.instrument_key, side: k.side ?? "" })),
    fence: Number(row.fence),
    instance: row.instance ?? "",
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : new Date(row.created_at).getTime(),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.getTime() : new Date(row.expires_at).getTime(),
    renewedAt: row.renewed_at instanceof Date ? row.renewed_at.getTime() : new Date(row.renewed_at).getTime(),
  };
}

export class PgReservationPort implements DurableReservationPort {
  readonly name = "postgres";
  /** A shared database really is shared between processes. */
  readonly crossProcess = true;

  private verified = false;

  /**
   * Ready only while the pool is up AND the schema was verified since it came up.
   * Cleared whenever the pool is down, never latched forever, so a lost pool
   * invalidates the verification exactly like the Mongo adapter's index check did.
   */
  get ready(): boolean {
    if (!isPgReady()) {
      this.verified = false;
      return false;
    }
    return this.verified;
  }

  /**
   * Prove the schema exists (the migrations that carry the unique constraint have
   * run) and that the authority answers. The unique constraint on
   * box_reservation_keys(deployment_id, broker, instrument_key) is the whole atomicity
   * guarantee, so its absence is fatal — like the Mongo adapter refusing to be ready
   * without its unique index.
   */
  async ensureReady(): Promise<void> {
    if (!isPgReady()) throw new Error("PostgreSQL pool is not ready");
    await withClient(async (client) => {
      const constraintOk = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conname = 'box_reservation_keys_pkey' AND contype = 'p'
         ) AS ok`,
      );
      if (!constraintOk.rows[0]?.ok) {
        throw new Error(
          "box_reservation_keys is missing its (deployment_id, broker, instrument_key) primary key; " +
            "contract exclusion would not be enforced — run migrations",
        );
      }
      const seqOk = await client.query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_class WHERE relname = 'box_reservation_fence_seq' AND relkind = 'S'
         ) AS ok`,
      );
      if (!seqOk.rows[0]?.ok) {
        throw new Error("box_reservation_fence_seq is missing — run migrations");
      }
      // Prove the server answers and the clock path works.
      await client.query("SELECT clock_timestamp()");
    });
    this.verified = true;
  }

  /** The authority's wall clock. One clock for every worker. */
  async serverTimeMs(): Promise<number> {
    const { rows } = await getPool().query<{ at: Date }>(`SELECT clock_timestamp() AS at`);
    const at = rows[0]?.at;
    const ms = at instanceof Date ? at.getTime() : new Date(at as unknown as string).getTime();
    if (!Number.isFinite(ms)) throw new Error("PostgreSQL did not return a server timestamp");
    return ms;
  }

  /** A genuinely monotonic fencing token from the shared sequence. */
  async nextFence(_deployment: string): Promise<number> {
    const { rows } = await getPool().query<{ seq: number }>(
      `SELECT nextval('box_reservation_fence_seq') AS seq`,
    );
    const seq = Number(rows[0]?.seq);
    if (!Number.isFinite(seq)) throw new Error("PostgreSQL did not return a fencing token");
    return seq;
  }

  /**
   * ONE reservation, atomically. All keys or none.
   *
   * The owner row and every key row are written in a single transaction. A key that
   * is already claimed raises 23505 and rolls the whole insert back (`key_conflict`);
   * a colliding owner PK is our own re-entrant row (`owner_exists`); anything else is
   * a real failure and must propagate so the tier reports `unavailable` and live entry
   * fails closed rather than treating the contracts as free.
   */
  async insert(doc: DurableReservationDoc): Promise<InsertReservationResult> {
    try {
      return await withTx(async (client) => {
        try {
          await client.query(
            `INSERT INTO box_reservation_owners
               (owner, deployment, broker, generation, mode, fence, instance,
                created_at, expires_at, renewed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              doc.owner, doc.deployment, doc.broker, doc.generation, doc.mode, doc.fence,
              doc.instance, new Date(doc.createdAt), new Date(doc.expiresAt), new Date(doc.renewedAt),
            ],
          );
        } catch (err) {
          if (isUniqueViolation(err) && ownerConflict(err)) {
            throw new InsertConflict("owner_exists");
          }
          throw err;
        }
        const sideByKey = new Map(doc.sides.map((s) => [s.key, s.side]));
        for (const key of doc.keys) {
          try {
            await client.query(
              `INSERT INTO box_reservation_keys (deployment_id, broker, instrument_key, owner, side)
               VALUES ($1,$2,$3,$4,$5)`,
              [doc.deployment, doc.broker, key, doc.owner, sideByKey.get(key) ?? ""],
            );
          } catch (err) {
            if (isUniqueViolation(err)) throw new InsertConflict("key_conflict");
            throw err;
          }
        }
        return "inserted" as InsertReservationResult;
      });
    } catch (err) {
      if (err instanceof InsertConflict) return err.result;
      throw err;
    }
  }

  /**
   * Delete owners in `deployment` overlapping `keys` whose expiry is at/before
   * `notAfter`. Race-safe by construction: a lease can only be renewed while still
   * unexpired, so anything matching this predicate has already lost ownership. Key
   * rows cascade with the owner.
   */
  async deleteExpired(args: {
    readonly deployment: string;
    readonly keys?: readonly string[];
    readonly notAfter: number;
  }): Promise<number> {
    return withClient(async (client) => {
      if (args.keys !== undefined) {
        const { rowCount } = await client.query(
          `DELETE FROM box_reservation_owners o
           WHERE o.deployment = $1
             AND o.expires_at <= $2
             AND EXISTS (
               SELECT 1 FROM box_reservation_keys k
               WHERE k.owner = o.owner AND k.instrument_key = ANY($3::text[])
             )`,
          [args.deployment, new Date(args.notAfter), [...args.keys]],
        );
        return rowCount ?? 0;
      }
      const { rowCount } = await client.query(
        `DELETE FROM box_reservation_owners
         WHERE deployment = $1 AND expires_at <= $2`,
        [args.deployment, new Date(args.notAfter)],
      );
      return rowCount ?? 0;
    });
  }

  /** Owners in `deployment` overlapping `keys` and still live at `now`. */
  async findLiveByKeys(args: {
    readonly deployment: string;
    readonly keys: readonly string[];
    readonly now: number;
  }): Promise<DurableReservationDoc[]> {
    return withClient(async (client) => {
      const { rows } = await client.query<OwnerRow>(
        `SELECT DISTINCT o.* FROM box_reservation_owners o
         JOIN box_reservation_keys k ON k.owner = o.owner
         WHERE o.deployment = $1
           AND k.instrument_key = ANY($2::text[])
           AND o.expires_at > $3`,
        [args.deployment, [...args.keys], new Date(args.now)],
      );
      const out: DurableReservationDoc[] = [];
      for (const row of rows) out.push(toDoc(row, await loadKeys(client, row.owner)));
      return out;
    });
  }

  async findByOwner(owner: string): Promise<DurableReservationDoc | null> {
    return withClient(async (client) => {
      const { rows } = await client.query<OwnerRow>(
        `SELECT * FROM box_reservation_owners WHERE owner = $1`,
        [owner],
      );
      const row = rows[0];
      if (!row) return null;
      return toDoc(row, await loadKeys(client, owner));
    });
  }

  /** Owner-scoped, optionally fence-pinned. Never key-scoped. */
  async deleteOwned(args: { readonly owner: string; readonly fence?: number }): Promise<number> {
    return withClient(async (client) => {
      const { rowCount } = args.fence !== undefined
        ? await client.query(
            `DELETE FROM box_reservation_owners WHERE owner = $1 AND fence = $2`,
            [args.owner, args.fence],
          )
        : await client.query(`DELETE FROM box_reservation_owners WHERE owner = $1`, [args.owner]);
      return rowCount ?? 0;
    });
  }

  /**
   * Extend a lease only if the owner (and fence/broker/generation, when given) still
   * matches AND it has not already expired on the authority's clock. The
   * `expires_at > now` predicate makes renewal a genuine ownership test, not a blind
   * write: a lapsed lease cannot be resurrected because a challenger may have taken
   * the contracts by then.
   */
  async renewOwned(args: {
    readonly owner: string;
    readonly fence?: number;
    readonly broker?: string;
    readonly generation?: number;
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<DurableReservationDoc | null> {
    return withClient(async (client) => {
      const conditions = ["owner = $1", "expires_at > $2"];
      const values: unknown[] = [args.owner, new Date(args.now), new Date(args.expiresAt)];
      // $3 is expires_at set value; extra guard params start at $4.
      let p = 4;
      if (args.fence !== undefined) { conditions.push(`fence = $${p++}`); values.push(args.fence); }
      if (args.broker !== undefined) { conditions.push(`broker = $${p++}`); values.push(args.broker); }
      if (args.generation !== undefined) { conditions.push(`generation = $${p++}`); values.push(args.generation); }
      const { rows } = await client.query<OwnerRow>(
        `UPDATE box_reservation_owners
         SET expires_at = $3, renewed_at = $2
         WHERE ${conditions.join(" AND ")}
         RETURNING *`,
        values,
      );
      const row = rows[0];
      if (!row) return null;
      return toDoc(row, await loadKeys(client, row.owner));
    });
  }

  /**
   * Delete every reservation owned by ONE process. The prefix carries deployment,
   * host, pid and per-boot token, so it cannot match a sibling worker. Matched as a
   * literal prefix (LIKE with escaped metacharacters), never a pattern.
   */
  async deleteByOwnerPrefix(prefix: string): Promise<number> {
    const escaped = prefix.replace(/([%_\\])/g, "\\$1");
    return withClient(async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM box_reservation_owners WHERE owner LIKE $1 ESCAPE '\\'`,
        [`${escaped}%`],
      );
      return rowCount ?? 0;
    });
  }

  async countLive(args: { readonly deployment: string; readonly now: number }): Promise<number> {
    return withClient(async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM box_reservation_owners
         WHERE deployment = $1 AND expires_at > $2`,
        [args.deployment, new Date(args.now)],
      );
      return Number(rows[0]?.n ?? 0);
    });
  }
}

/** Internal signal used to unwind an insert transaction with a typed result. */
class InsertConflict extends Error {
  constructor(readonly result: InsertReservationResult) {
    super(result);
    this.name = "InsertConflict";
  }
}

/** True when a unique violation names the owner primary key rather than a key row. */
function ownerConflict(err: unknown): boolean {
  const constraint = (err as { constraint?: string } | null)?.constraint ?? "";
  return constraint === "box_reservation_owners_pkey";
}
