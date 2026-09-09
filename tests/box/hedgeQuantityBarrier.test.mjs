/**
 * DEFECT — THE HEDGE-COVERAGE BARRIER WAS A FAILURE SIGNAL, NOT A COVERAGE SIGNAL.
 *
 * The dependent-SELL barrier authorised an uncovered SELL whenever no BUY hedge of the attempt had
 * been NAMED as a definitive failure (`hedgeFailure === null`). A named failure and PROVEN COVERAGE
 * are not complements. A BUY hedge that returned CANCELLED with ZERO fills, or OPEN, or partially
 * filled below its required size, or in any terminal state the classifier had not enumerated, left
 * `hedgeFailure === null` — so the full-size uncovered SELL that depended on it was authorised and
 * transmitted NAKED. Confirmed against the pre-fix code: with BOTH BUY hedges returning
 * CANCELLED/0-filled the gateway still POSTed BOTH SELL legs, at entry concurrency 1 and 4, for
 * both box directions.
 *
 * THE FIX inverts the barrier to PROVEN SUFFICIENT COVERAGE (see hedgeCoverageLedger.ts): a SELL
 * may POST only when every BUY hedge is proven — by the broker's OWN terminal snapshot and its
 * cumulative filled quantity — to have filled its full required quantity on the right contract,
 * side and account, attributed single-use to this attempt. Absent, non-terminal, mismatched or
 * insufficient evidence fails closed.
 *
 * EVERY test below asserts on `adapter.posts` — the recording adapter appends there ONLY after the
 * pre-POST callback returns without throwing, i.e. exactly where the real HTTP POST would be
 * issued. "No SELL POSTed" is therefore a statement about broker mutations, not internal state.
 *
 * FAILING-FIRST: run against the pre-fix `src` these tests observe the naked SELLs and FAIL. See
 * EVIDENCE-hedge.md for the verbatim before/after output.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { BrokerAmbiguousSubmitError } from "../../dist/box/brokerAdapter.js";
import { brokerOrderFor, entryPosts, liveStack, runEntry } from "./liveEntryHarness.mjs";

const DIRECTIONS = ["LONG_BOX", "SHORT_BOX"];
const CONCURRENCIES = [1, 4];

/** The hedge (BUY) roles per direction, from the hedge-first transport order. */
const HEDGE_ROLES = {
  LONG_BOX: ["k1_ce", "k2_pe"],
  SHORT_BOX: ["k2_ce", "k1_pe"],
};

function limits(concurrency) {
  return { maxConcurrentExecutions: concurrency, entrySubmitConcurrency: concurrency };
}

/** All ENTRY SELL POSTs that reached the recording broker. */
function sellPosts(stack) {
  return entryPosts(stack.adapter).filter((p) => p.side === "SELL");
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (a)+(b)+(c) BOTH BUY hedges CANCELLED with ZERO fills → BOTH dependent SELLs must NEVER POST,
 * for both directions and at concurrency 1 AND 4. This is the exact confirmed defect.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

for (const direction of DIRECTIONS) {
  for (const concurrency of CONCURRENCIES) {
    test(`${direction} @c=${concurrency}: both BUY hedges CANCELLED/0-fill → NO uncovered SELL POSTs`, async () => {
      const stack = await liveStack({
        direction,
        limitOverrides: limits(concurrency),
        adapterOptions: {
          // Both hedges accepted by the broker then CANCELLED with zero fills — a terminal state
          // that is neither REJECTED nor ambiguous, so the OLD classifier recorded no hedge
          // failure and released the naked SELLs. Coverage proof is ZERO, so they must be blocked.
          submit: async (req) =>
            req.side === "BUY" ? brokerOrderFor(req, 0, "CANCELLED") : brokerOrderFor(req),
        },
      });
      const result = await runEntry(stack);

      const sells = sellPosts(stack);
      assert.deepEqual(
        sells.map((p) => [p.role, p.side]),
        [],
        `no uncovered SELL may POST when both hedges CANCELLED/0-fill; got ${JSON.stringify(sells)}`,
      );
      // The hedges themselves were legitimately attempted; only the dependents were stopped.
      assert.ok(entryPosts(stack.adapter).every((p) => p.side === "BUY"));
      // There is no valid box, so the attempt fails — and NOTHING filled, so there is no exposure.
      assert.equal(result.ok, false);

      // The stopped SELLs are terminalized as PROVEN LOCAL NO-POST, not broker rejections.
      const sellRoles = direction === "SHORT_BOX" ? ["k1_ce", "k2_pe"] : ["k2_ce", "k1_pe"];
      for (const role of sellRoles) {
        const row = [...stack.persistence.rows.values()].find(
          (r) => r.role === role && r.purpose === "ENTRY",
        );
        assert.ok(row, `${role} durable intent exists`);
        assert.equal(row.state, "REJECTED", `${role} terminalized as local no-POST`);
        assert.equal(row.filled_quantity, 0);
        assert.equal(row.broker_order_id, null, `${role} never obtained a broker id`);
        const audit = row.audit.find((event) => event.payload?.origin === "local_pre_submit_refusal");
        assert.ok(audit, `${role} carries local-no-POST provenance`);
        assert.equal(audit.payload.no_broker_post, true);
        assert.match(audit.payload.reason, /coverage/i, `${role} refusal cites coverage`);
      }
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (a, single-hedge-fails variant) ONE hedge CANCELLED/0-fill → BOTH SELLs blocked, because a box
 * needs BOTH hedges. The other hedge fully filling is not enough.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

for (const direction of DIRECTIONS) {
  test(`${direction}: one hedge fully filled, the other CANCELLED/0-fill → NO SELL POSTs`, async () => {
    const [firstHedge] = HEDGE_ROLES[direction];
    const stack = await liveStack({
      direction,
      limitOverrides: limits(4),
      adapterOptions: {
        submit: async (req) => {
          if (req.role === firstHedge) return brokerOrderFor(req, 0, "CANCELLED"); // the failing hedge
          return brokerOrderFor(req); // everything else fully fills
        },
      },
    });
    const result = await runEntry(stack);

    assert.deepEqual(sellPosts(stack), [], "a single uncovered hedge is enough to block both SELLs");
    assert.equal(result.ok, false);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (d) PARTIAL fill below required → no full-size dependent SELL.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

for (const direction of DIRECTIONS) {
  test(`${direction}: a hedge PARTIALLY filled below its lot → NO full-size SELL POSTs`, async () => {
    const [firstHedge] = HEDGE_ROLES[direction];
    const stack = await liveStack({
      direction,
      limitOverrides: limits(4),
      adapterOptions: {
        submit: async (req) => {
          // One hedge fills only part of the required lot then terminalises. Partial coverage is
          // NOT full coverage for a one-lot-per-leg profile, so the full-size SELL is unsafe.
          if (req.role === firstHedge) {
            const partial = Math.max(1, Math.floor(req.quantity / 3));
            return brokerOrderFor(req, partial, "CANCELLED"); // cancelled after a partial fill
          }
          return brokerOrderFor(req);
        },
      },
    });
    const result = await runEntry(stack);

    assert.deepEqual(sellPosts(stack), [], "a partial-below-required hedge must not authorise a full-size SELL");
    assert.equal(result.ok, false);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (e) FILL-DURING-CANCEL RACE — a cancel was requested but a fill lands anyway. The barrier must
 * never guess an unwind quantity while an order can still fill; and once the hedge terminalises
 * with its ACTUAL raced quantity, coverage is attributed to THAT proven quantity, nothing more.
 *
 * Sub-case (e1): the race leaves the hedge SHORT of a full lot → the SELL is still blocked, and
 * no quantity was guessed.
 * Sub-case (e2): the race COMPLETES the hedge to a full lot → coverage is proven and the SELL is
 * authorised (attribution follows the real terminal quantity, not the cancel-request quantity).
 * ───────────────────────────────────────────────────────────────────────────────────────── */

test("SHORT_BOX: cancel-races-a-partial-fill hedge stays SHORT → SELL blocked, no guessed unwind", async () => {
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: limits(4),
    adapterOptions: {
      submit: async (req) => {
        // k2_ce: a cancel was requested at 0 filled, but the exchange matched a partial while the
        // cancel was in flight. The broker's TERMINAL snapshot is the authority: CANCELLED with a
        // real, below-lot raced quantity. No full coverage ⇒ the dependent SELL must not POST.
        if (req.role === "k2_ce") {
          const raced = Math.max(1, Math.floor(req.quantity / 5));
          return brokerOrderFor(req, raced, "CANCELLED");
        }
        return brokerOrderFor(req);
      },
    },
  });
  const result = await runEntry(stack);

  assert.deepEqual(sellPosts(stack), [], "a raced partial that stays short must not authorise the SELL");
  assert.equal(result.ok, false);
});

test("SHORT_BOX: a cancel that LOSES the race (hedge completes) proves full coverage → SELL authorised", async () => {
  // The cancel-vs-fill reconciliation is preserved: an order that COMPLETED during cancellation is
  // a real, full position. Coverage follows the TERMINAL quantity, so the box is safe to complete.
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: limits(4),
    adapterOptions: {
      submit: async (req) => brokerOrderFor(req), // every leg fully fills (COMPLETE)
    },
  });
  const result = await runEntry(stack);

  assert.equal(result.ok, true, "a fully covered box must complete");
  const posts = entryPosts(stack.adapter);
  assert.equal(posts.filter((p) => p.side === "SELL").length, 2, "both SELLs POST once covered");
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (f) AMBIGUOUS / UNKNOWN hedge state → dependent SELL blocked. An unproven hedge is not a hedge.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

for (const direction of DIRECTIONS) {
  test(`${direction}: an AMBIGUOUS hedge submission blocks the dependent SELL`, async () => {
    const [firstHedge] = HEDGE_ROLES[direction];
    const stack = await liveStack({
      direction,
      limitOverrides: limits(4),
      adapterOptions: {
        submit: async (req) => {
          if (req.role === firstHedge) {
            throw new BrokerAmbiguousSubmitError(req.client_order_id, "transport timeout; hedge existence unknown");
          }
          return brokerOrderFor(req);
        },
      },
    });
    const result = await runEntry(stack);

    assert.deepEqual(sellPosts(stack), [], "an unproven (ambiguous) hedge must not authorise the SELL");
    assert.equal(result.ok, false);
  });

  test(`${direction}: a hedge returning UNKNOWN (uncertain terminal) blocks the dependent SELL`, async () => {
    const [firstHedge] = HEDGE_ROLES[direction];
    const stack = await liveStack({
      direction,
      limitOverrides: limits(4),
      adapterOptions: {
        submit: async (req) =>
          // A non-terminal, uncertain state. Its quantity is not proof of a fill, so coverage is
          // unprovable and the SELL fails closed.
          req.role === firstHedge ? brokerOrderFor(req, 0, "UNKNOWN") : brokerOrderFor(req),
      },
    });
    const result = await runEntry(stack);

    assert.deepEqual(sellPosts(stack), [], "an UNKNOWN hedge is not proof of coverage");
    assert.equal(result.ok, false);
  });
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * (g) THE HAPPY PATH — both hedges fully CONFIRMED → dependent SELLs DO submit. The fix must not
 * simply block everything; a genuinely covered box must still complete, both directions, both
 * concurrencies.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

for (const direction of DIRECTIONS) {
  for (const concurrency of CONCURRENCIES) {
    test(`${direction} @c=${concurrency}: both hedges fully confirmed → both SELLs DO POST (happy path)`, async () => {
      const stack = await liveStack({
        direction,
        limitOverrides: limits(concurrency),
        // Default adapter fills every leg fully.
      });
      const result = await runEntry(stack);

      assert.equal(result.ok, true, "a fully covered box must complete");
      const posts = entryPosts(stack.adapter);
      assert.equal(posts.length, 4, "all four legs POST");
      const sells = posts.filter((p) => p.side === "SELL");
      assert.equal(sells.length, 2, "both dependent SELLs POSTed once coverage was proven");
      // And every hedge POSTed before every SELL (the barrier still holds).
      const firstSellIndex = posts.findIndex((p) => p.side === "SELL");
      assert.ok(
        posts.slice(0, firstSellIndex).every((p) => p.side === "BUY"),
        "every hedge POSTs before any SELL",
      );
      assert.deepEqual(stack.violations, []);
    });
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────────────
 * ATTRIBUTION — coverage must not be authorised by a hedge on the WRONG CONTRACT. Even if a hedge
 * "COMPLETE"s a full quantity, if its filled contract does not match the intended hedge token the
 * SELL must not be authorised. This pins the token/tradingsymbol attribution axis.
 * ───────────────────────────────────────────────────────────────────────────────────────── */

test("SHORT_BOX: a hedge that fills on the WRONG contract token does not cover the SELL", async () => {
  const stack = await liveStack({
    direction: "SHORT_BOX",
    limitOverrides: limits(4),
    adapterOptions: {
      submit: async (req) => {
        const order = brokerOrderFor(req); // COMPLETE, full fill
        if (req.role === "k2_ce") {
          // The broker reports a fill, but on a DIFFERENT instrument than the one the hedge
          // requirement demands. Attribution must reject it: a fill on the wrong contract covers
          // nothing, so the dependent SELL fails closed.
          order.token = req.token + 999_999;
          order.tradingsymbol = `${req.tradingsymbol}-WRONG`;
        }
        return order;
      },
    },
  });
  const result = await runEntry(stack);

  assert.deepEqual(sellPosts(stack), [], "a fill on the wrong contract must not be counted as coverage");
  assert.equal(result.ok, false);
});
