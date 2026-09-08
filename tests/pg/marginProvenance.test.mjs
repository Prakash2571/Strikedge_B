/**
 * MARGIN PROVENANCE must be persisted, projected and served.
 *
 * THE GAP THIS CLOSES
 * `box_trades.margin` stored one number and nothing recorded which model produced it. The
 * models are not interchangeable:
 *
 *   kite_basket / dhan_multi   position-aware, NETTED figures
 *   dhan_per_leg_fallback      per-leg margins SUMMED — a conservative UPPER bound that
 *                              materially over-states a hedged four-leg Box
 *   unavailable                a figure was requested and none obtained
 *
 * `src/box/engine.ts` warned on the console when it fell back to the per-leg sum, and its
 * own comment said the quiet part out loud: "Only `res.total` is persisted, so once stored
 * an inflated per-leg sum is indistinguishable from a real basket margin — and it is
 * plausible enough to go unnoticed." The specification requires the opposite: "Never
 * silently use Dhan per-leg margin as if it were hedge-adjusted basket margin. Persist the
 * margin source."
 *
 * The outbox payload additionally derived `margin_source` as
 * `margin === null ? "unknown" : "broker"`, which told a reader only whether a number
 * existed — so the projected history could not distinguish a netted figure from an upper
 * bound that differs by roughly an order of magnitude.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { setup, teardown, loadRepository, baseTrade } from "./helpers.mjs";

let ctx;
let repo;
let serialize;

test.before(async () => {
  ctx = await setup("marginprov");
  repo = await loadRepository();
  serialize = await import("../../dist/box/serialize.js");
});

test.after(async () => {
  await teardown(ctx);
});

async function newTrade(lower, upper) {
  const rec = await repo.insertBoxTrade(baseTrade({ lower_strike: lower, upper_strike: upper }));
  assert.ok(rec, "the trade must insert");
  return String(rec._id);
}

async function marginRow(id) {
  const { rows } = await ctx.pool.query(
    `SELECT margin, margin_source FROM box_trades WHERE id = $1`,
    [id],
  );
  return rows[0];
}

test("each margin model is persisted verbatim, not collapsed to a boolean", async () => {
  const sources = ["kite_basket", "dhan_multi", "dhan_per_leg_fallback", "unavailable"];
  let strike = 31000;
  for (const source of sources) {
    const id = await newTrade(strike, strike + 200);
    strike += 400;
    await repo.setBoxTradeMargin(id, 12345, source);
    const row = await marginRow(id);
    assert.equal(Number(row.margin), 12345);
    assert.equal(row.margin_source, source, `${source} must round-trip exactly`);
  }
});

test("the conservative per-leg fallback stays distinguishable from a netted figure", async () => {
  // The whole point: two trades with the SAME number must not look the same.
  const netted = await newTrade(33000, 33200);
  const inflated = await newTrade(33400, 33600);
  await repo.setBoxTradeMargin(netted, 50_000, "kite_basket");
  await repo.setBoxTradeMargin(inflated, 50_000, "dhan_per_leg_fallback");

  const a = await marginRow(netted);
  const b = await marginRow(inflated);
  assert.equal(Number(a.margin), Number(b.margin), "identical figures, by construction");
  assert.notEqual(
    a.margin_source,
    b.margin_source,
    "…but their provenance must differ, or an upper bound reads as a netted margin",
  );
});

test("an unknown margin model is refused by the CHECK constraint", async () => {
  // A typo must not become silent provenance.
  const id = await newTrade(34000, 34200);
  await assert.rejects(
    () =>
      ctx.pool.query(`UPDATE box_trades SET margin_source = 'made_up' WHERE id = $1`, [id]),
    /margin_source/,
    "the constraint must name itself in the failure",
  );
});

test("NULL provenance is preserved, never back-filled with a guess", async () => {
  // NULL means "predates provenance capture", which is honestly different from
  // 'unavailable' ("we asked and got nothing"). Manufacturing a value would invent
  // provenance that was never observed.
  const id = await newTrade(35000, 35200);
  const before = await marginRow(id);
  assert.equal(before.margin_source, null, "a fresh trade carries no provenance yet");

  await repo.setBoxTradeMargin(id, 999);
  const after = await marginRow(id);
  assert.equal(Number(after.margin), 999, "the figure is stored");
  assert.equal(after.margin_source, null, "an omitted source must not invent one");
});

test("an omitted source never ERASES provenance a previous write recorded", async () => {
  // The COALESCE in setBoxTradeMargin. A later margin refresh that happens not to know the
  // model must not downgrade a trade from 'dhan_per_leg_fallback' to unknown, or the
  // over-statement warning would silently disappear.
  const id = await newTrade(36000, 36200);
  await repo.setBoxTradeMargin(id, 100, "dhan_per_leg_fallback");
  await repo.setBoxTradeMargin(id, 200);
  const row = await marginRow(id);
  assert.equal(Number(row.margin), 200, "the newer figure wins");
  assert.equal(row.margin_source, "dhan_per_leg_fallback", "the known provenance survives");
});

test("the Mongo projection carries the REAL source, not a derived boolean", async () => {
  const id = await newTrade(37000, 37200);
  await repo.setBoxTradeMargin(id, 4242, "dhan_per_leg_fallback");

  const { rows } = await ctx.pool.query(
    `SELECT payload FROM mongo_outbox
       WHERE aggregate_type = 'box_trade' AND aggregate_id = $1 AND event_type = 'trade_margin'`,
    [id],
  );
  assert.equal(rows.length, 1, "a margin write must project");
  assert.equal(
    rows[0].payload.margin_source,
    "dhan_per_leg_fallback",
    "the projection must carry the model name, not \"broker\"/\"unknown\"",
  );
  assert.notEqual(rows[0].payload.margin_source, "broker", "the derived value is gone");
});

test("the HTTP serialisation exposes margin_source so the dashboard can show provenance", async () => {
  const id = await newTrade(38000, 38200);
  await repo.setBoxTradeMargin(id, 777, "dhan_multi");
  const trade = await repo.findBoxTradeById(id);
  const wire = serialize.serializeBoxTrade(trade);
  assert.equal(wire.margin, 777);
  assert.equal(
    wire.margin_source,
    "dhan_multi",
    "margin_source must reach the API — it was persisted but unexposed before",
  );
});
