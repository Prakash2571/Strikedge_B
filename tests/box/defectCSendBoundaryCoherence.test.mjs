/**
 * DEFECT C — CROSS-LEG COHERENCE AT THE ACTUAL ENTRY-SEND BOUNDARY.
 *
 * The gateway evaluates four-leg coherence twice, both times BEFORE the legs are handed to the
 * order manager (`executionGateway.ts:261` admission, `:327` re-check). The FINAL send guard —
 * the `beforeSend` callback the manager passes into `adapter.submitOrder`, checkpoint 5 of 5 at
 * `orderManager.ts:1734` — ran only `checkedFeedBlockReason` (a SINGLE-leg book re-validation) and
 * `entryGuardBlockReason` (ownership, arm, breaker, hedge coverage). `orderManager.ts` did not
 * import `executionCoherence` at all, and `LiveEntryGuardInputs` had no dispersion field, so
 * cross-leg receive dispersion was structurally impossible to consider at the send boundary.
 *
 * REPRODUCED ON e357b83: with a configured receive-dispersion limit of 500 ms, books coherent at
 * admission, and dispersion rising to 1,000 ms while the legs sit in adapter pacing, ALL FOUR
 * ENTRY ORDERS STILL TRANSMIT. Per-leg freshness alone cannot catch this: every individual book is
 * young, they are simply young at four DIFFERENT instants.
 *
 * THE POLICY UNDER TEST is deliberately exposure-aware, not blanket:
 *   • NO exposure yet (nothing of this attempt has POSTed) → deterioration BLOCKS. Refusing costs
 *     nothing at that point, and it is the only moment at which it costs nothing.
 *   • Exposure ALREADY taken → the attempt COMPLETES the hedged box and records the degradation.
 *     Refusing leg 4 after legs 1-3 have posted converts a timing blip into a partial entry with a
 *     real recovery cost, and a complete box is hedged by construction. The existing post-fill
 *     economics gate is what rejects a box that turned out uneconomic.
 *   • Protective reduction is never gated: the guard is passed for ENTRY legs only.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BOX_LEG_ROLES } from "../../dist/box/types.js";
import { exitSideFor } from "../../dist/box/math.js";
import { positionFrom } from "./helpers.mjs";
import { liveStack, runEntry, entryPosts, NOW } from "./liveEntryHarness.mjs";

/** A clock the test can move, so "later" means later to the gateway too. */
function movableClock(start = NOW) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

/**
 * Make the four books arrive at DIFFERENT instants, `ms` apart, without making any of them stale.
 *
 * Time is advanced by `ms` and three of the four legs are re-ticked at the new instant; the fourth
 * keeps its original receive time. Every individual book is then at most `ms` old — per-leg
 * freshness alone cannot see the problem — but the cross-sectional receive dispersion is `ms`.
 */
function disperseBooks(stack, clock, ms) {
  clock.advance(ms);
  const laggard = "k1_pe";
  for (const role of BOX_LEG_ROLES) {
    if (role === laggard) continue;
    const token = stack.candidate.legs[role].token;
    const q = stack.quotes.get(token);
    stack.quotes.applyTicks(
      [{
        token,
        last_price: q.last,
        bid: q.bid,
        ask: q.ask,
        bids: q.bids.map((l) => ({ price: l.price, qty: l.qty, orders: l.orders })),
        asks: q.asks.map((l) => ({ price: l.price, qty: l.qty, orders: l.orders })),
      }],
      clock.now(),
    );
  }
}

/* ───────── C1: dispersion rises during pacing, before any POST ───────── */

test("defect C1 — dispersion rising during pacing BLOCKS every entry POST", async () => {
  const clock = movableClock();
  let deteriorated = false;
  const stack = await liveStack({
    direction: "LONG_BOX",
    clock,
    config: { maxCrossLegReceiveDispersionMs: 500, quoteMaxAgeMs: 30_000 },
    adapterOptions: {
      // The window the defect lives in: the leg has been dequeued, persisted and is waiting its
      // turn in adapter pacing. Nothing has reached the broker yet.
      duringPacing: () => {
        if (deteriorated) return;
        deteriorated = true;
        disperseBooks(stack, clock, 1_000);
      },
    },
  });

  const result = await runEntry(stack);

  assert.equal(result.ok, false, "an incoherent four-leg snapshot must not open a box");
  assert.equal(
    entryPosts(stack.adapter).length, 0,
    `no entry order may transmit once cross-leg dispersion exceeds the configured limit; ` +
      `transmitted ${entryPosts(stack.adapter).length}`,
  );
});

/* ───────── C2: a coherent book still transmits (no false positive) ───────── */

test("defect C2 — a coherent four-leg snapshot still transmits all four legs", async () => {
  const stack = await liveStack({
    direction: "LONG_BOX",
    config: { maxCrossLegReceiveDispersionMs: 500, quoteMaxAgeMs: 30_000 },
  });

  const result = await runEntry(stack);
  assert.equal(result.ok, true, "coherent books must not be refused");
  assert.equal(entryPosts(stack.adapter).length, 4);
});

/* ───────── C3: deterioration WITHIN the limit does not block ───────── */

test("defect C3 — dispersion inside the configured limit does not block the send", async () => {
  const clock = movableClock();
  let deteriorated = false;
  const stack = await liveStack({
    direction: "LONG_BOX",
    config: { maxCrossLegReceiveDispersionMs: 500, quoteMaxAgeMs: 30_000 },
    clock,
    adapterOptions: {
      duringPacing: () => {
        if (deteriorated) return;
        deteriorated = true;
        disperseBooks(stack, clock, 100);
      },
    },
  });

  const result = await runEntry(stack);
  assert.equal(result.ok, true, "100ms of dispersion under a 500ms limit is admissible");
  assert.equal(entryPosts(stack.adapter).length, 4);
});

/* ───────── C4: once exposure exists, the box is COMPLETED, not abandoned ───────── */

test("defect C4 — deterioration after the first POST completes the box instead of stranding it", async () => {
  const clock = movableClock();
  let deteriorated = false;
  const stack = await liveStack({
    direction: "LONG_BOX",
    config: { maxCrossLegReceiveDispersionMs: 500, quoteMaxAgeMs: 30_000 },
    limitOverrides: { entrySubmitConcurrency: 1 },
    clock,
    adapterOptions: {
      duringPacing: (_req, adapter) => {
        // Deteriorate only once the FIRST leg has already reached the broker.
        if (deteriorated || adapter.posts.length < 1) return;
        deteriorated = true;
        disperseBooks(stack, clock, 1_000);
      },
    },
  });

  const result = await runEntry(stack);

  assert.equal(
    entryPosts(stack.adapter).length, 4,
    "abandoning legs 2-4 after leg 1 posted would manufacture a partial entry and a recovery cost",
  );
  assert.equal(result.ok, true, "a complete four-leg box is hedged; the economics gate judges it after the fact");
});

/* ───────── C5: protective reduction is never gated by entry coherence ───────── */

test("defect C5 — an EXIT is not refused by a cross-leg entry gate", async () => {
  const clock = movableClock();
  const stack = await liveStack({
    direction: "LONG_BOX",
    config: { maxCrossLegReceiveDispersionMs: 500, quoteMaxAgeMs: 30_000 },
    clock,
  });
  const entry = await runEntry(stack);
  assert.equal(entry.ok, true, "fixture: the box must be entered first");

  // Now deteriorate the books badly and reduce. Reduction removes risk; the entry gate must not
  // touch it.
  disperseBooks(stack, clock, 2_000);
  const position = positionFrom(stack.candidate, { direction: "LONG_BOX" });
  const detectionLegs = BOX_LEG_ROLES.map((role) => {
    const leg = stack.candidate.legs[role];
    const q = stack.quotes.get(leg.token);
    const side = exitSideFor(role, "LONG_BOX");
    return {
      role, side, token: leg.token, tradingsymbol: leg.tradingsymbol, strike: leg.strike,
      instrument_type: leg.instrument_type,
      price: side === "BUY" ? q.asks[0].price : q.bids[0].price,
      qty_at_touch: stack.candidate.lot_size,
      bid: q.bids[0].price, bid_qty: q.bids[0].qty,
      ask: q.asks[0].price, ask_qty: q.asks[0].qty,
      quote_at: q.at, exchange_at: null, quote_version: q.version, depth: null,
      age_ms: 0, fresh: true, executable: true,
    };
  });

  const before = stack.adapter.posts.length;
  await stack.gateway.simulateLeggingExit({ position, detectionLegs, detectedAt: clock.now() });
  assert.ok(
    stack.adapter.posts.length > before,
    "an exit must still reach the broker when four-leg entry coherence has deteriorated",
  );
});
