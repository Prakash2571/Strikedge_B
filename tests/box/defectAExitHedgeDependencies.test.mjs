/**
 * DEFECT A — SAFE EXITS AND RECOVERY (both brokers).
 *
 * REPRODUCTION ON MAIN (e357b83). A complete LONG_BOX is exited. `simulateLeggingExit`
 * (executionGateway.ts:596) builds one request per outstanding role and fires ALL FOUR
 * concurrently through `Promise.allSettled`. There is no dependency between the exit BUYs that
 * CLOSE the short legs and the exit SELLs that RELEASE the long hedges. So when both
 * short-closing BUYs come back CANCELLED with zero fills while both hedge-releasing SELLs fill,
 * the account is left holding TWO NAKED SHORT OPTIONS with their hedges sold away.
 *
 * The entry path already has a proven-coverage barrier (hedgeCoverageLedger.ts, whose own header
 * says "SCOPE — ENTRY ONLY"). The exit path had nothing equivalent. These tests are the exit-side
 * equivalent, and they are written to FAIL on main.
 *
 * PAIRING. Within a box the two calls form one vertical and the two puts form the other. Whichever
 * leg of a vertical is LONG is the hedge for whichever leg is SHORT:
 *
 *   LONG_BOX   long k1_ce hedges short k2_ce ;  long k2_pe hedges short k1_pe
 *   SHORT_BOX  long k2_ce hedges short k1_ce ;  long k1_pe hedges short k2_pe
 *
 * THE PROPERTY UNDER TEST is not "the SELL never goes out". It is: a hedge-releasing SELL may only
 * ever be transmitted for quantity that is PROVEN no longer needed as cover, i.e.
 * `releasable = hedge_outstanding - short_still_outstanding`. Uncertain evidence releases nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BOX_ENTRY_SIDES_BY_DIRECTION } from "../../dist/box/types.js";
import { exitSideFor } from "../../dist/box/math.js";
import {
  hedgeForShort,
  isExposureSafeExitSequence,
  planExitDependencies,
  releasableHedgeQuantity,
  verticalPartner,
} from "../../dist/box/exitDependencies.js";
import { LOT, positionFrom } from "./helpers.mjs";
import { brokerOrderFor, liveStack, NOW, runEntry } from "./liveEntryHarness.mjs";

/* ────────────────────────── fixture helpers ────────────────────────── */

/** The two SHORT roles (entry SELL) and the two LONG roles (entry BUY) for a direction. */
function geometry(direction) {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const shorts = Object.keys(sides).filter((r) => sides[r] === "SELL");
  const longs = Object.keys(sides).filter((r) => sides[r] === "BUY");
  return { shorts, longs };
}

/** Detection legs for the exit, priced from the seeded book on the EXIT side of each role. */
function exitDetection(candidate, quotes, direction) {
  return Object.keys(candidate.legs).map((role) => {
    const leg = candidate.legs[role];
    const q = quotes.get(leg.token);
    const side = exitSideFor(role, direction);
    return {
      role,
      side,
      token: leg.token,
      tradingsymbol: leg.tradingsymbol,
      strike: leg.strike,
      instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: candidate.lot_size,
      bid: q.bids[0].price,
      bid_qty: q.bids[0].quantity,
      ask: q.asks[0].price,
      ask_qty: q.asks[0].quantity,
      quote_at: q.at,
      exchange_at: null,
      quote_version: q.version,
      depth: null,
      age_ms: 0,
      fresh: true,
      executable: true,
    };
  });
}

/**
 * Build the live stack, ENTER a real box through it, then expose an EXIT runner.
 *
 * The entry is genuine and fully filled: that is what gives the order manager the ATTRIBUTED
 * exposure which authorises a reduction at all (`orderManager.ts` `canReduce`). Without it the
 * exit is refused as "exceeds configured live leg quantity limits" and the test would be
 * measuring nothing.
 *
 * `answer(role, req)` returns the BrokerOrder the (recording) broker reports for each EXIT leg.
 */
async function exitStack(direction, answer, extra = {}) {
  const stack = await liveStack({
    direction,
    adapterOptions: {
      submit: async (req, adapter) =>
        (req.purpose === "ENTRY"
          ? brokerOrderFor(req, req.quantity, "COMPLETE")
          : answer(req.role, req, adapter)),
      ...(extra.adapterOptions ?? {}),
    },
    ...extra.stack,
  });

  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must actually be entered before it can be exited");
  const entryPostCount = stack.adapter.posts.length;
  assert.equal(entryPostCount, 4, "fixture: a complete box is four entry POSTs");

  const position = positionFrom(stack.candidate, { direction, ...(extra.position ?? {}) });
  const run = () => stack.gateway.simulateLeggingExit({
    position,
    detectionLegs: exitDetection(stack.candidate, stack.quotes, direction),
    detectedAt: NOW,
  });
  return { ...stack, position, entryPostCount, run };
}

/** Every EXIT POST that actually reached the (recording) broker, in transmission order. */
const exitPosts = (adapter) => adapter.posts.filter((p) => p.purpose !== "ENTRY");
const postsFor = (adapter, role) => exitPosts(adapter).filter((p) => p.role === role);

/* ───────────────── A1: both short-closing BUYs fail ───────────────── */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  test(`defect A — ${direction}: when BOTH short-closing BUYs cancel with zero fills, NO hedge quantity may be sold`, async () => {
    const { shorts, longs } = geometry(direction);
    const stack = await exitStack(direction, (role, req) =>
      // The exit BUY on a short role comes back CANCELLED, zero filled: the short is still open.
      shorts.includes(role)
        ? brokerOrderFor(req, 0, "CANCELLED")
        : brokerOrderFor(req, req.quantity, "COMPLETE"));

    const result = await stack.run();

    assert.equal(result.ok, false, "an exit that closed nothing cannot be reported clean");

    // THE SAFETY PROPERTY. Both shorts are still fully outstanding, so their hedges are still
    // needed in full and NOT ONE UNIT of either hedge may have been transmitted for sale.
    for (const hedge of longs) {
      const sold = postsFor(stack.adapter, hedge).reduce((n, p) => n + p.quantity, 0);
      assert.equal(
        sold, 0,
        `hedge ${hedge} must not be sold while its paired short is still fully outstanding ` +
          `(transmitted ${sold} of ${LOT})`,
      );
    }

    // And the short-closing BUYs must genuinely have been attempted first.
    for (const short of shorts) {
      assert.equal(postsFor(stack.adapter, short).length, 1, `short ${short} close must be attempted`);
    }
  });
}

/* ──────────── A2: partial short close then hedge release ──────────── */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  test(`defect A — ${direction}: a PARTIAL short close may only release the proven-free hedge quantity`, async () => {
    const { shorts, longs } = geometry(direction);
    const closed = 30; // of LOT (75) — 45 of each short stays open.
    const stack = await exitStack(direction, (role, req) =>
      shorts.includes(role)
        ? brokerOrderFor(req, closed, "CANCELLED") // terminal, partially filled: 45 still short
        : brokerOrderFor(req, req.quantity, "COMPLETE"));

    const result = await stack.run();
    assert.equal(result.ok, false, "a partial exit is not a clean exit");

    for (const hedge of longs) {
      const sold = postsFor(stack.adapter, hedge).reduce((n, p) => n + p.quantity, 0);
      assert.equal(
        sold, closed,
        `hedge ${hedge} may only release the ${closed} units whose short cover is proven gone, ` +
          `never the ${LOT - closed} still covering an open short (transmitted ${sold})`,
      );
    }
  });
}

/* ─────── A3: a short-close that can still fill releases nothing ─────── */

test("defect A — LONG_BOX: while a short-closing BUY is still WORKING, no hedge may be released", async () => {
  const { shorts, longs } = geometry("LONG_BOX");
  const stack = await exitStack("LONG_BOX", (role, req) =>
    shorts.includes(role)
      // Non-terminal: the broker may still fill this. Guessing the remaining short quantity here
      // is exactly what the contract forbids.
      ? brokerOrderFor(req, 0, "OPEN")
      : brokerOrderFor(req, req.quantity, "COMPLETE"));

  const result = await stack.run();
  assert.equal(result.ok, false);

  for (const hedge of longs) {
    const sold = postsFor(stack.adapter, hedge).reduce((n, p) => n + p.quantity, 0);
    assert.equal(sold, 0, `hedge ${hedge} must not be released against an undecided short close`);
  }
});

/* ────── A4: long-only residual geometry must not deadlock the exit ────── */

test("defect A — LONG_BOX: a LONG-ONLY residual exits immediately (no nonexistent short to close first)", async () => {
  const { longs } = geometry("LONG_BOX");
  const stack = await exitStack("LONG_BOX", (role, req) => brokerOrderFor(req, req.quantity, "COMPLETE"), {
    // Both shorts are already flat; only the two long hedges remain.
    position: { remaining_qty_by_role: { k1_ce: LOT, k2_ce: 0, k2_pe: LOT, k1_pe: 0 }, position_state: "PARTIALLY_EXITED" },
  });

  const result = await stack.run();

  assert.equal(result.ok, true, "long-only exposure has no uncovered short, so its exit must complete");
  for (const hedge of longs) {
    const sold = postsFor(stack.adapter, hedge).reduce((n, p) => n + p.quantity, 0);
    assert.equal(sold, LOT, `long-only ${hedge} must be sold in full, not held back for a nonexistent short`);
  }
});

/* ───────── A5: ordering — every short close precedes every release ───────── */

for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
  test(`defect A — ${direction}: every short-closing BUY is transmitted before any hedge-releasing SELL`, async () => {
    const { shorts } = geometry(direction);
    const stack = await exitStack(direction, (role, req) => brokerOrderFor(req, req.quantity, "COMPLETE"));

    const result = await stack.run();
    assert.equal(result.ok, true, "a fully filled exit is clean");

    const order = exitPosts(stack.adapter).map((p) => (shorts.includes(p.role) ? "CLOSE_SHORT" : "RELEASE_HEDGE"));
    const firstRelease = order.indexOf("RELEASE_HEDGE");
    const lastClose = order.lastIndexOf("CLOSE_SHORT");
    assert.equal(order.length, 4, "all four legs must be transmitted on a clean exit");
    assert.ok(
      firstRelease > lastClose,
      `exit transport order must close shorts before releasing hedges, got ${order.join(",")}`,
    );
  });
}

/* ───────── A6: a cancel that raced a fill is authoritative evidence ───────── */

test("defect A — LONG_BOX: a CANCELLED short close that raced a full fill releases the whole hedge", async () => {
  const { shorts, longs } = geometry("LONG_BOX");
  const stack = await exitStack("LONG_BOX", (role, req) =>
    // The cancel lost the race: terminal CANCELLED, but the broker filled everything first.
    shorts.includes(role)
      ? brokerOrderFor(req, req.quantity, "CANCELLED")
      : brokerOrderFor(req, req.quantity, "COMPLETE"));

  const result = await stack.run();
  assert.equal(result.ok, true, "the shorts are genuinely closed, so the exit is complete");
  for (const hedge of longs) {
    const sold = postsFor(stack.adapter, hedge).reduce((n, p) => n + p.quantity, 0);
    assert.equal(sold, LOT, "a terminal CANCELLED carrying a full fill is proof the cover is free");
  }
});

/* ───────── A7: an unprovable short close releases nothing and is flagged ───────── */

test("defect A — LONG_BOX: an UNKNOWN short close releases nothing and raises the invariant", async () => {
  const { shorts, longs } = geometry("LONG_BOX");
  const stack = await exitStack("LONG_BOX", (role, req) =>
    shorts.includes(role)
      ? brokerOrderFor(req, 0, "UNKNOWN")
      : brokerOrderFor(req, req.quantity, "COMPLETE"));

  const result = await stack.run();
  assert.equal(result.ok, false);
  assert.match(result.detail, /uncertain/, "an unprovable exit quantity must be reported as uncertain");
  assert.ok(
    stack.violations.some((v) => /uncertain broker terminal quantity/.test(v)),
    "an unprovable terminal quantity must raise the invariant",
  );
  for (const hedge of longs) {
    assert.equal(
      postsFor(stack.adapter, hedge).length, 0,
      `hedge ${hedge} must not be released against an unprovable short close`,
    );
  }
});

/* ───────── A8: the PURE planner, enumerated over both directions ───────── */

test("planExitDependencies pairs every short with the long beside it, in both directions", () => {
  for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
    const { shorts, longs } = geometry(direction);
    const pairs = hedgeForShort(direction);
    assert.deepEqual(Object.keys(pairs).sort(), [...shorts].sort(), "every short has a hedge");
    for (const short of shorts) {
      assert.ok(longs.includes(pairs[short]), `${pairs[short]} must be a LONG leg to hedge ${short}`);
      assert.equal(verticalPartner(short), pairs[short], "the hedge is the other leg of the same vertical");
    }

    const intact = Object.fromEntries([...shorts, ...longs].map((r) => [r, LOT]));
    const plan = planExitDependencies(direction, intact);
    assert.deepEqual(plan.wave0.map((s) => s.role).sort(), [...shorts].sort(), "wave 0 closes the shorts");
    assert.deepEqual(plan.wave1.map((s) => s.role).sort(), [...longs].sort(), "wave 1 releases the hedges");
    for (const slot of plan.wave1) assert.equal(slot.covers, verticalPartner(slot.role));
    for (const slot of plan.wave0) assert.equal(slot.side, "BUY", "closing a short is a BUY");
    for (const slot of plan.wave1) assert.equal(slot.side, "SELL", "releasing a hedge is a SELL");
  }
});

test("planExitDependencies puts an unpaired long in wave 0 and never waits on a nonexistent short", () => {
  for (const direction of ["LONG_BOX", "SHORT_BOX"]) {
    const { longs } = geometry(direction);
    const plan = planExitDependencies(direction, Object.fromEntries(longs.map((r) => [r, LOT])));
    assert.equal(plan.wave1.length, 0, "nothing can be waiting: there is no short outstanding");
    assert.deepEqual(plan.wave0.map((s) => s.kind), longs.map(() => "close_unpaired_long"));
  }
});

test("releasableHedgeQuantity releases exactly the proven-free quantity and fails closed", () => {
  const rel = (hedge, shortOutstanding, confirmedClosed, certain) =>
    releasableHedgeQuantity({ hedgeOutstanding: hedge, short: { shortOutstanding, confirmedClosed, certain } });

  assert.equal(rel(75, 75, 75, true), 75, "a fully closed short frees the whole hedge");
  assert.equal(rel(75, 75, 30, true), 30, "a 30-unit close frees 30 units of cover");
  assert.equal(rel(75, 75, 0, true), 0, "a proven zero close frees nothing");
  assert.equal(rel(75, 75, 75, false), 0, "an UNPROVEN close frees nothing, whatever it claims");
  assert.equal(rel(75, 0, 0, false), 75, "no short outstanding means the long is not a hedge at all");
  assert.equal(rel(75, 30, 0, true), 45, "only the quantity a short actually needs is retained");
  assert.equal(rel(75, 75, 200, true), 75, "a nonsense overfill is clamped, never amplified");
  assert.equal(rel(75, 75, Number.NaN, true), 0, "an unreadable fill frees nothing");
  assert.equal(rel(Number.NaN, 75, 75, true), 0, "an unreadable hedge quantity frees nothing");
  assert.equal(rel(75, -1, 75, true), 0, "a negative short figure frees nothing");
});

test("isExposureSafeExitSequence rejects the pre-fix sequence and accepts the fixed one", () => {
  const outstanding = { k1_ce: 75, k2_ce: 75, k2_pe: 75, k1_pe: 75 };
  // What main did: sell both hedges in full while the short closes filled nothing.
  assert.equal(isExposureSafeExitSequence("LONG_BOX", outstanding, [
    { role: "k2_ce", quantity: 75, filled: 0 },
    { role: "k1_pe", quantity: 75, filled: 0 },
    { role: "k1_ce", quantity: 75, filled: 75 },
    { role: "k2_pe", quantity: 75, filled: 75 },
  ]), false);
  // What the fix does: nothing is released, because nothing was proven free.
  assert.equal(isExposureSafeExitSequence("LONG_BOX", outstanding, [
    { role: "k2_ce", quantity: 75, filled: 0 },
    { role: "k1_pe", quantity: 75, filled: 0 },
  ]), true);
  // A genuine full close then a full release is safe.
  assert.equal(isExposureSafeExitSequence("LONG_BOX", outstanding, [
    { role: "k2_ce", quantity: 75, filled: 75 },
    { role: "k1_pe", quantity: 75, filled: 75 },
    { role: "k1_ce", quantity: 75, filled: 75 },
    { role: "k2_pe", quantity: 75, filled: 75 },
  ]), true);
});
