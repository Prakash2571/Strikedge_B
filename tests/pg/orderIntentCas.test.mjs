/**
 * Order-intent CAS against a real PostgreSQL.
 *
 * The transition is the authoritative fact: `updateBoxOrderIntent` locks the row,
 * validates the expected state against the allowed-predecessor map, writes with the
 * durable pre-image, and reports the pre/post cumulative filled quantities read under
 * that lock — never a caller snapshot.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseIntent, audit } from "./helpers.mjs";

let ctx;
let repo;

test.before(async () => {
  ctx = await setup("cas");
  repo = await loadRepository();
});
test.after(async () => { await teardown(ctx); });

async function seed(overrides) {
  const intent = baseIntent({
    client_order_id: `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k1_ce:a1`,
    ...overrides,
  });
  await repo.createBoxOrderIntent(intent);
  return intent.client_order_id;
}

test("two concurrent CAS writers: exactly one wins the same fill", async () => {
  const coid = await seed({ state: "OPEN", filled_quantity: 0 });
  // Both writers attempt PARTIALLY_FILLED -> 40, from the same stale snapshot.
  const [a, b] = await Promise.all([
    repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED")),
    repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED")),
  ]);
  // Both may report applied (idempotent same-value writes), but the durable deltas must
  // sum to the final cumulative quantity: one establishes 0->40, the other 40->40.
  const deltas = [a, b].map((r) => (r.current_filled_quantity ?? 0) - (r.previous_filled_quantity ?? 0));
  const total = deltas.reduce((s, d) => s + d, 0);
  const final = (await repo.findBoxOrderIntentByClientId(coid)).filled_quantity;
  assert.equal(final, 40);
  assert.equal(total, 40, `durable deltas must sum to the final cumulative quantity, got ${deltas}`);
});

test("concurrent DISTINCT fills: deltas sum to final cumulative", async () => {
  const coid = await seed({ state: "OPEN", filled_quantity: 0 });
  const [a, b] = await Promise.all([
    repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 30 }, audit("PARTIALLY_FILLED")),
    repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 75 }, audit("PARTIALLY_FILLED")),
  ]);
  const final = (await repo.findBoxOrderIntentByClientId(coid)).filled_quantity;
  const total = [a, b].map((r) => (r.current_filled_quantity ?? 0) - (r.previous_filled_quantity ?? 0)).reduce((s, d) => s + d, 0);
  assert.equal(final, 75);
  assert.equal(total, 75);
});

test("stale expected state is rejected", async () => {
  const coid = await seed({ state: "OPEN" });
  const res = await repo.updateBoxOrderIntent(
    coid, { state: "COMPLETE" }, audit("COMPLETE"), ["CREATED"], // expected CREATED but it is OPEN
  );
  assert.equal(res.applied, false);
  assert.equal((await repo.findBoxOrderIntentByClientId(coid)).state, "OPEN");
});

test("cumulative-fill attribution returns durable pre/post values", async () => {
  const coid = await seed({ state: "OPEN", filled_quantity: 10 });
  const res = await repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 55 }, audit("PARTIALLY_FILLED"));
  assert.equal(res.applied, true);
  assert.equal(res.previous_filled_quantity, 10);
  assert.equal(res.current_filled_quantity, 55);
});

test("illegal predecessor is rejected", async () => {
  const coid = await seed({ state: "CREATED" });
  // CREATED -> COMPLETE is not an allowed transition (predecessors of COMPLETE exclude CREATED).
  const res = await repo.updateBoxOrderIntent(coid, { state: "COMPLETE" }, audit("COMPLETE"));
  assert.equal(res.applied, false);
  assert.equal((await repo.findBoxOrderIntentByClientId(coid)).state, "CREATED");
});

test("conflicting broker order id is rejected", async () => {
  const coid = await seed({ state: "SUBMITTING", broker_order_id: null });
  const first = await repo.updateBoxOrderIntent(coid, { state: "ACKNOWLEDGED", broker_order_id: "B-100" }, audit("ACKNOWLEDGED"));
  assert.equal(first.applied, true);
  // A different broker_order_id must not overwrite the established one.
  const conflict = await repo.updateBoxOrderIntent(coid, { state: "OPEN", broker_order_id: "B-999" }, audit("OPEN"));
  assert.equal(conflict.applied, false);
  assert.equal((await repo.findBoxOrderIntentByClientId(coid)).broker_order_id, "B-100");
});

test("idempotent audit replay does not double-append or double-count", async () => {
  const coid = await seed({ state: "OPEN", filled_quantity: 0 });
  const a = audit("PARTIALLY_FILLED");
  const r1 = await repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, a);
  const r2 = await repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, a); // same audit id
  assert.equal(r1.applied, true);
  const after = await repo.findBoxOrderIntentByClientId(coid);
  assert.equal(after.filled_quantity, 40);
  // The audit id appears exactly once.
  const occurrences = after.audit.filter((e) => e.audit_id === a.audit_id).length;
  assert.equal(occurrences, 1, "audit id must appear exactly once after replay");
  // The replay reports a zero-width transition (nothing new established).
  assert.equal((r2.current_filled_quantity ?? 0) - (r2.previous_filled_quantity ?? 0), 0);
});

test("broker order id globally unique conflict is surfaced as a failed transition", async () => {
  const coidA = await seed({ state: "SUBMITTING", broker_order_id: null });
  const coidB = await seed({ state: "SUBMITTING", broker_order_id: null });
  await repo.updateBoxOrderIntent(coidA, { state: "ACKNOWLEDGED", broker_order_id: "DUP-1" }, audit("ACKNOWLEDGED"));
  // Assigning the same broker_order_id to a different intent violates the per-broker
  // unique index; the guarded write must not silently succeed.
  await assert.rejects(
    () => repo.updateBoxOrderIntent(coidB, { state: "ACKNOWLEDGED", broker_order_id: "DUP-1" }, audit("ACKNOWLEDGED")),
  );
});

test("immutable-field reuse of a client order id is refused", async () => {
  const coid = await seed({ state: "CREATED", quantity: 75 });
  await assert.rejects(
    () => repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, quantity: 50 })),
    /immutable field/i,
  );
});
