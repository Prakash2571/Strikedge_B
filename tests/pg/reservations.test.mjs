/**
 * Durable reservation authority against a real PostgreSQL.
 *
 * The PgReservationPort normalises the instrument set into box_reservation_keys with a
 * UNIQUE(deployment_id, broker, instrument_key) constraint, so all-or-none acquisition
 * is a single transaction: the first conflicting key rolls the whole insert back.
 * Fences come from a real sequence; authority time from clock_timestamp().
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadPgStore } from "./helpers.mjs";

let ctx;
let PgReservationPort;

test.before(async () => {
  ctx = await setup("resv");
  ({ PgReservationPort } = await loadPgStore());
});
test.after(async () => { await teardown(ctx); });

const DEPLOYMENT = "test-deploy";
const BROKER = "zerodha";

function doc(owner, keys, fence, expiresAt, now = Date.now()) {
  return {
    owner, deployment: DEPLOYMENT, broker: BROKER, generation: 1, mode: "live",
    keys, sides: keys.map((k) => ({ key: k, side: "BUY" })), fence,
    instance: `${owner}:1:boot`, createdAt: now, expiresAt, renewedAt: now,
  };
}

test("ensureReady verifies the schema and answers the clock", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  assert.equal(port.ready, true);
  const t = await port.serverTimeMs();
  assert.ok(Number.isFinite(t) && t > 0);
});

test("fences are strictly increasing and monotonic", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const a = await port.nextFence(DEPLOYMENT);
  const b = await port.nextFence(DEPLOYMENT);
  const c = await port.nextFence(DEPLOYMENT);
  assert.ok(a < b && b < c, `fences must strictly increase: ${a} ${b} ${c}`);
});

test("concurrent acquisition of an overlapping set is all-or-none: one winner", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const keys = ["nfo:AAA", "nfo:BBB", "nfo:CCC", "nfo:DDD"];
  const now = await port.serverTimeMs();
  const f1 = await port.nextFence(DEPLOYMENT);
  const f2 = await port.nextFence(DEPLOYMENT);
  const [r1, r2] = await Promise.all([
    port.insert(doc("owner-A", keys, f1, now + 60_000, now)),
    port.insert(doc("owner-B", ["nfo:CCC", "nfo:EEE"], f2, now + 60_000, now)),
  ]);
  // Exactly one inserted; the other lost on the shared key CCC.
  const results = [r1, r2];
  const inserted = results.filter((r) => r === "inserted").length;
  const conflicts = results.filter((r) => r === "key_conflict").length;
  assert.equal(inserted, 1, `exactly one winner, got ${results}`);
  assert.equal(conflicts, 1);
  // The loser left NO key rows behind (all-or-none).
  const live = await port.findLiveByKeys({ deployment: DEPLOYMENT, keys, now: now + 1 });
  assert.equal(live.length, 1);
});

test("a colliding OWNER id is reported as owner_exists, not key_conflict", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  assert.equal(await port.insert(doc("dup-owner", ["nfo:X1"], await port.nextFence(DEPLOYMENT), now + 60_000, now)), "inserted");
  assert.equal(await port.insert(doc("dup-owner", ["nfo:X2"], await port.nextFence(DEPLOYMENT), now + 60_000, now)), "owner_exists");
});

test("renewal is guarded by owner + fence + not-expired", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  const fence = await port.nextFence(DEPLOYMENT);
  await port.insert(doc("renew-owner", ["nfo:R1"], fence, now + 1_000, now));
  // Correct owner + fence, not expired -> renews.
  const ok = await port.renewOwned({ owner: "renew-owner", fence, now, expiresAt: now + 60_000 });
  assert.ok(ok, "renewal with matching owner+fence must succeed");
  assert.equal(ok.expiresAt, now + 60_000);
  // Wrong fence -> refused.
  const wrongFence = await port.renewOwned({ owner: "renew-owner", fence: fence + 999, now, expiresAt: now + 120_000 });
  assert.equal(wrongFence, null);
});

test("expiry boundary: a lapsed lease cannot be renewed", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  const fence = await port.nextFence(DEPLOYMENT);
  await port.insert(doc("expired-owner", ["nfo:E1"], fence, now - 1, now - 60_000)); // already expired
  const renewed = await port.renewOwned({ owner: "expired-owner", fence, now, expiresAt: now + 60_000 });
  assert.equal(renewed, null, "an expired lease must not be renewable");
});

test("release requires exact owner AND fence", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  const fence = await port.nextFence(DEPLOYMENT);
  await port.insert(doc("rel-owner", ["nfo:D1"], fence, now + 60_000, now));
  assert.equal(await port.deleteOwned({ owner: "rel-owner", fence: fence + 1 }), 0, "wrong fence releases nothing");
  assert.equal(await port.deleteOwned({ owner: "rel-owner", fence }), 1, "exact owner+fence releases");
  // Key rows cascaded away with the owner.
  const live = await port.findLiveByKeys({ deployment: DEPLOYMENT, keys: ["nfo:D1"], now: now + 1 });
  assert.equal(live.length, 0);
});

test("deleteExpired garbage-collects only lapsed owners, never live ones", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  await port.insert(doc("gc-live", ["nfo:G1"], await port.nextFence(DEPLOYMENT), now + 60_000, now));
  await port.insert(doc("gc-dead", ["nfo:G2"], await port.nextFence(DEPLOYMENT), now - 1, now - 60_000));
  // Key-scoped GC, exactly as the durable tier's reaper uses it, so this test is
  // unaffected by expired leases other tests in this schema left behind.
  const removed = await port.deleteExpired({ deployment: DEPLOYMENT, keys: ["nfo:G1", "nfo:G2"], notAfter: now });
  assert.equal(removed, 1);
  assert.ok(await port.findByOwner("gc-live"), "the live lease must survive GC");
  assert.equal(await port.findByOwner("gc-dead"), null);
});

test("deleteByOwnerPrefix removes only this process's leases", async () => {
  const port = new PgReservationPort();
  await port.ensureReady();
  const now = await port.serverTimeMs();
  await port.insert(doc("proc-1:host:pid:", ["nfo:P1"], await port.nextFence(DEPLOYMENT), now + 60_000, now));
  await port.insert(doc("proc-2:host:pid:", ["nfo:P2"], await port.nextFence(DEPLOYMENT), now + 60_000, now));
  const removed = await port.deleteByOwnerPrefix("proc-1:");
  assert.equal(removed, 1);
  assert.ok(await port.findByOwner("proc-2:host:pid:"));
});
