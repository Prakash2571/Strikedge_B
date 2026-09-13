/**
 * FILL DEDUPLICATION SEPARATED FROM STATUS AND PRICE UPDATES.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECT
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * OrderStreamConsumer forwarded an observation to order management ONLY when the cumulative filled
 * quantity had increased:
 *
 *     if (result.apply.outcome === "applied" || outcome === "applied_overfill") applyToAdapter(...)
 *
 * The cumulative ledger returns `stale_cumulative` for any observation whose quantity does not
 * exceed what it already holds. So every update that changed something OTHER than quantity was
 * silently dropped:
 *
 *   - OPEN(0) → CANCELLED(0)   cumulative 0 both times ⇒ the CANCELLATION never arrived.
 *   - OPEN(0) → REJECTED(0)    identical — and a rejection is exactly what a caller waits on.
 *   - PARTIAL(q) → CANCELLED(q) same cumulative ⇒ the fill was kept but the cancellation of the
 *                               REMAINDER vanished.
 *   - average-price enrichment at unchanged quantity ⇒ dropped entirely.
 *
 * A second, compounding bug: the WORKING-ORDER set was only cleared on `remaining <= 0`. A zero-fill
 * cancel/reject leaves `remaining` at the full requested quantity, so a dead order stayed "working"
 * forever — and the idle detector, which only alarms while a working order is outstanding, therefore
 * demoted a perfectly healthy stream to DEGRADED and refused new entry because of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE DRIVES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The real OrderStreamConsumer, the real cumulative ledger inside the real OrderUpdateProjection,
 * and the real Kite/Dhan frame parsers, against an adapter that models the production adapters'
 * contract (cumulative-monotonic, terminal-state-preserving, returns the merged order). Every case
 * is run for BOTH brokers' wire formats, because their status vocabularies genuinely differ and the
 * fix must not assume they are the same.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OrderStreamConsumer } from "../../dist/box/orderStreamConsumer.js";
import { parseKiteOrderFrame } from "../../dist/brokers/zerodha/orderUpdates.js";
import { parseDhanOrderAlert } from "../../dist/brokers/dhan/orderFeed.js";

/* ─────────────────────────── an adapter with the production contract ─────────────────────────── */

/**
 * Models what kiteBrokerAdapter/dhanBrokerAdapter.applyOrderUpdate actually guarantee:
 *   - cumulative-monotonic: a quantity below what is held is refused, and a delta is never re-added;
 *   - terminal states are never regressed by a later non-terminal label;
 *   - a normalized `state` is returned on the merged order.
 * `fills` counts how many times exposure was actually created, which is how these tests prove a
 * status or price forward does NOT manufacture a fill.
 */
class ContractAdapter {
  constructor() {
    this.orders = new Map();
    this.applyCalls = 0;
    this.wakes = 0;
  }
  register(clientOrderId, quantity) {
    this.orders.set(clientOrderId, {
      client_order_id: clientOrderId,
      quantity,
      filled_quantity: 0,
      state: "OPEN",
      average_price: null,
      fills: [],
      statusHistory: [],
    });
  }
  get(clientOrderId) {
    return this.orders.get(clientOrderId);
  }
  applyOrderUpdate(update) {
    this.applyCalls++;
    const known = this.orders.get(update.clientOrderId);
    if (!known) return undefined;
    const q = update.cumulativeQty;
    // MONOTONIC: refuse a regression outright, exactly as the production adapters do.
    if (q !== undefined && q !== null && Number.isFinite(q) && q < known.filled_quantity) {
      return { ...known };
    }
    if (q !== undefined && q !== null && Number.isFinite(q) && q > known.filled_quantity) {
      known.fills.push({ quantity: q - known.filled_quantity });
      known.filled_quantity = q;
    }
    if (update.averagePrice != null && Number.isFinite(update.averagePrice)) {
      known.average_price = update.averagePrice;
    }
    const label = String(update.rawStatus ?? "").toUpperCase();
    if (label) known.statusHistory.push(label);
    const claimed = normalise(label, known.filled_quantity, known.quantity);
    const wasTerminal = TERMINAL.has(known.state);
    if (claimed && !(wasTerminal && !TERMINAL.has(claimed))) known.state = claimed;
    this.wakes++;
    return { ...known };
  }
}

const TERMINAL = new Set(["COMPLETE", "CANCELLED", "REJECTED"]);

/** Stands in for the adapters' kiteState/dhanOrderState, covering both vocabularies. */
function normalise(label, filled, quantity) {
  if (!label) return null;
  if (label === "COMPLETE") return "COMPLETE";
  if (label === "TRADED") return quantity > 0 && filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "COMPLETE";
  if (label === "PART_TRADED") return filled >= quantity && quantity > 0 ? "COMPLETE" : "PARTIALLY_FILLED";
  if (label.includes("CANCEL") || label === "CLOSED") return "CANCELLED";
  if (label.includes("REJECT")) return "REJECTED";
  if (label === "EXPIRED") return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "CANCELLED";
  if (label === "PENDING") return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "OPEN";
  if (label === "OPEN") return filled > 0 && filled < quantity ? "PARTIALLY_FILLED" : "OPEN";
  return null;
}

/* ─────────────────────────── wire-format builders (the REAL parsers) ─────────────────────────── */

const KITE = {
  name: "zerodha",
  tag: "BOXTAG9",
  account: "AB1234",
  brokerOrderId: "230099",
  /** Build a real Kite postback frame and parse it with the production parser. */
  obs({ status, filled, avg = null, stamp = "2026-09-13 10:00:01" }) {
    const frame = JSON.stringify({
      type: "order",
      data: {
        order_id: this.brokerOrderId,
        status,
        ...(filled === undefined ? {} : { filled_quantity: filled }),
        ...(avg === null ? {} : { average_price: avg }),
        tag: this.tag,
        user_id: this.account,
        exchange_update_timestamp: stamp,
      },
    });
    const parsed = parseKiteOrderFrame(frame);
    assert.equal(parsed.type, "order", "the production Kite parser must yield an order observation");
    return parsed.observation;
  },
  OPEN: "OPEN",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  COMPLETE: "COMPLETE",
};

const DHAN = {
  name: "dhan",
  tag: "Bxyz9k1ce",
  account: "1000000001",
  brokerOrderId: "9199",
  obs({ status, filled, avg = null, stamp = "2026-09-13 10:00:01" }) {
    const raw = JSON.stringify({
      Type: "order_alert",
      Data: {
        CorrelationId: this.tag,
        OrderNo: this.brokerOrderId,
        ClientId: this.account,
        ...(filled === undefined ? {} : { TradedQty: filled }),
        ...(avg === null ? {} : { AvgTradedPrice: avg }),
        Status: status,
        LastUpdatedTime: stamp,
      },
    });
    const obs = parseDhanOrderAlert(raw);
    assert.ok(obs, "the production Dhan parser must yield an observation");
    return obs;
  },
  OPEN: "PENDING",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  COMPLETE: "TRADED",
};

const BROKERS = [KITE, DHAN];

function makeConsumer(broker, { qty = 75 } = {}) {
  const adapter = new ContractAdapter();
  const clientOrderId = `BOX:T9:ENTRY:k1_ce:attempt-1`;
  const consumer = new OrderStreamConsumer({
    broker: broker.name,
    account: () => broker.account,
    adapter,
    streamEnabled: true,
    now: () => 1_700_000_000_000,
  });
  consumer.registerIntent({ clientOrderId, ownerTag: broker.tag, account: broker.account, requestedQty: qty });
  adapter.register(clientOrderId, qty);
  return { consumer, adapter, clientOrderId, qty };
}

/* ═══════════════ 1. OPEN(0) → CANCELLED(0) ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] OPEN(0) → CANCELLED(0) terminates the working order (was silently dropped)`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);

    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 0, stamp: "2026-09-13 10:00:01" }));
    assert.equal(consumer.workingOrderCount(), 1, "the order is working after the open");

    // Same second, same zero quantity — only the STATUS changed. This is the dropped case.
    consumer.ingestStreamObservation(b.obs({ status: b.CANCELLED, filled: 0, stamp: "2026-09-13 10:00:01" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.state, "CANCELLED", "the cancellation must reach order management");
    assert.equal(order.filled_quantity, 0, "and must not invent a fill");
    assert.equal(order.fills.length, 0, "no exposure was created by a status-only update");
    assert.equal(
      consumer.workingOrderCount(),
      0,
      "a zero-fill terminal must settle the working order — remaining is still 75, so the old " +
        "`remaining <= 0` test never fired and the idle detector expected events forever",
    );
    assert.ok(consumer.diagnostics().statusOnlyForwards >= 1, "the forward is counted as status-only");
    assert.equal(consumer.diagnostics().terminalSettlements, 1);
  });

  test(`[${b.name}] OPEN(0) → REJECTED(0) terminates the working order`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 0, stamp: "2026-09-13 10:00:01" }));
    consumer.ingestStreamObservation(b.obs({ status: b.REJECTED, filled: 0, stamp: "2026-09-13 10:00:01" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.state, "REJECTED", "a rejection is precisely what a caller is waiting on");
    assert.equal(order.filled_quantity, 0);
    assert.equal(order.fills.length, 0);
    assert.equal(consumer.workingOrderCount(), 0);
  });
}

/* ═══════════════ 2. PARTIAL(q) → CANCELLED(q) ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] PARTIAL(25) → CANCELLED(25) preserves the fill and cancels the remainder`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b, { qty: 75 });

    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 25, avg: 12.5, stamp: "10:00:01" }));
    assert.equal(adapter.get(clientOrderId).filled_quantity, 25);
    assert.equal(adapter.get(clientOrderId).fills.length, 1, "one real fill of 25");

    // Cancellation of the remainder at the SAME cumulative quantity.
    consumer.ingestStreamObservation(b.obs({ status: b.CANCELLED, filled: 25, avg: 12.5, stamp: "10:00:02" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.filled_quantity, 25, "the confirmed fill is PRESERVED, never rewound");
    assert.equal(order.fills.length, 1, "and not double-counted by the cancellation");
    assert.equal(order.state, "CANCELLED", "the remainder is cancelled");
    assert.equal(consumer.workingOrderCount(), 0, "the order is settled: no further events are expected");
  });
}

/* ═══════════════ 3. duplicate COMPLETE ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] a duplicate COMPLETE does not duplicate the fill, exposure or the wake`, () => {
    const { consumer, adapter, clientOrderId, qty } = makeConsumer(b);
    const complete = { status: b.COMPLETE, filled: qty, avg: 13.0, stamp: "10:00:05" };

    consumer.ingestStreamObservation(b.obs(complete));
    const afterFirst = adapter.applyCalls;
    assert.equal(adapter.get(clientOrderId).filled_quantity, qty);
    assert.equal(adapter.get(clientOrderId).fills.length, 1);

    // The exact same event, redelivered.
    consumer.ingestStreamObservation(b.obs(complete));

    const order = adapter.get(clientOrderId);
    assert.equal(order.filled_quantity, qty, "cumulative unchanged");
    assert.equal(order.fills.length, 1, "exactly ONE fill — a redelivery must not create exposure");
    assert.equal(
      adapter.applyCalls,
      afterFirst,
      "a redelivered event carries nothing new on any track, so it never reaches order management",
    );
  });
}

/* ═══════════════ 4. same-fill price enrichment ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] average-price enrichment at unchanged quantity updates price and creates NO fill`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);

    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 25, avg: 12.0, stamp: "10:00:01" }));
    assert.equal(adapter.get(clientOrderId).average_price, 12.0);
    assert.equal(adapter.get(clientOrderId).fills.length, 1);

    // Same status, same quantity, BETTER price information.
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 25, avg: 12.35, stamp: "10:00:02" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.average_price, 12.35, "the enrichment reached order management");
    assert.equal(order.filled_quantity, 25, "quantity untouched");
    assert.equal(order.fills.length, 1, "and NO second fill was manufactured");
    assert.ok(consumer.diagnostics().priceOnlyForwards >= 1, "counted as a price-only forward");
  });

  test(`[${b.name}] re-reporting the SAME price at the same quantity is not treated as new information`, () => {
    const { consumer, adapter } = makeConsumer(b);
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 25, avg: 12.0, stamp: "10:00:01" }));
    const calls = adapter.applyCalls;
    // A REST poll repeating an identical snapshot must not churn order management.
    consumer.ingestRestObservation(b.obs({ status: b.OPEN, filled: 25, avg: 12.0, stamp: "10:00:09" }));
    assert.equal(adapter.applyCalls, calls, "an unchanged re-poll is not forwarded");
  });
}

/* ═══════════════ 5. stale OPEN after a terminal state ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] a stale OPEN arriving AFTER a terminal state does not regress the lifecycle`, () => {
    const { consumer, adapter, clientOrderId, qty } = makeConsumer(b);

    consumer.ingestStreamObservation(b.obs({ status: b.COMPLETE, filled: qty, avg: 13.0, stamp: "10:00:05" }));
    assert.equal(adapter.get(clientOrderId).state, "COMPLETE");

    // A late, out-of-order OPEN with a lower quantity.
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 10, stamp: "10:00:01" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.state, "COMPLETE", "the terminal state is authoritative and is not overwritten");
    assert.equal(order.filled_quantity, qty, "and the quantity is not rewound");
    assert.equal(order.fills.length, 1);
    assert.ok(
      consumer.diagnostics().contradictoryTerminalObservations >= 1,
      "the contradiction is recorded as a reconciliation condition rather than absorbed silently",
    );
  });
}

/* ═══════════════ 6. REST → WS and WS → REST duplicate observations ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] REST first, then a duplicate WebSocket observation: counted once`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);
    const o = { status: b.OPEN, filled: 30, avg: 12.1, stamp: "10:00:03" };

    consumer.ingestRestObservation(b.obs(o));
    assert.equal(adapter.get(clientOrderId).filled_quantity, 30);
    assert.equal(adapter.get(clientOrderId).fills.length, 1);

    consumer.ingestStreamObservation(b.obs(o));
    assert.equal(adapter.get(clientOrderId).fills.length, 1, "the same truth arriving twice is one fill");
    assert.equal(consumer.projection().ledger(clientOrderId).cumulative, 30);
  });

  test(`[${b.name}] WebSocket first, then a duplicate REST poll: counted once`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);
    const o = { status: b.OPEN, filled: 30, avg: 12.1, stamp: "10:00:03" };

    consumer.ingestStreamObservation(b.obs(o));
    consumer.ingestRestObservation(b.obs(o));
    assert.equal(adapter.get(clientOrderId).fills.length, 1, "a REST poll never re-adds a streamed fill");
    assert.equal(consumer.projection().ledger(clientOrderId).cumulative, 30);
  });

  test(`[${b.name}] arrival order does not decide truth: the HIGHER cumulative wins either way`, () => {
    // The documented precedence policy: cumulative quantity is monotonic and authoritative
    // regardless of which channel delivered it or in what order. Arrival order is NOT event order.
    const forward = makeConsumer(b);
    forward.consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 30, stamp: "10:00:03" }));
    forward.consumer.ingestRestObservation(b.obs({ status: b.OPEN, filled: 50, stamp: "10:00:04" }));
    assert.equal(forward.adapter.get(forward.clientOrderId).filled_quantity, 50);

    const reversed = makeConsumer(b);
    reversed.consumer.ingestRestObservation(b.obs({ status: b.OPEN, filled: 50, stamp: "10:00:04" }));
    reversed.consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 30, stamp: "10:00:03" }));
    assert.equal(
      reversed.adapter.get(reversed.clientOrderId).filled_quantity,
      50,
      "the later-arriving LOWER quantity does not win just because it arrived last",
    );
  });
}

/* ═══════════════ 7. fill / cancel race and a LATE confirmed fill ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] a LATE confirmed fill after an observed cancellation is NOT lost`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b, { qty: 75 });

    // The cancellation is observed first, with nothing filled.
    consumer.ingestStreamObservation(b.obs({ status: b.CANCELLED, filled: 0, stamp: "10:00:04" }));
    assert.equal(adapter.get(clientOrderId).state, "CANCELLED");
    assert.equal(consumer.workingOrderCount(), 0);

    // Then the exchange confirms that 25 had actually traded before the cancel took effect.
    consumer.ingestRestObservation(b.obs({ status: b.CANCELLED, filled: 25, avg: 12.4, stamp: "10:00:05" }));

    const order = adapter.get(clientOrderId);
    assert.equal(
      order.filled_quantity,
      25,
      "the confirmed fill must NOT disappear merely because a cancellation was seen first — " +
        "that quantity is real, irreversible exposure",
    );
    assert.equal(order.fills.length, 1, "and it is counted exactly once");
    assert.equal(order.state, "CANCELLED", "the terminal state still stands for the remainder");
  });

  test(`[${b.name}] fill and cancel racing: exposure is the broker's cumulative, not the arrival order`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b, { qty: 75 });
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 40, avg: 12.2, stamp: "10:00:03" }));
    // Cancel arrives reporting the pre-fill figure — a genuinely stale quantity on a newer status.
    consumer.ingestStreamObservation(b.obs({ status: b.CANCELLED, filled: 0, stamp: "10:00:04" }));

    const order = adapter.get(clientOrderId);
    assert.equal(order.filled_quantity, 40, "a stale quantity on a newer status must not rewind exposure");
    assert.equal(order.state, "CANCELLED", "while the newer status is still adopted");
    assert.equal(order.fills.length, 1);
  });
}

/* ═══════════════ 8. invalid / overfilled quantities ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] an OVERFILL is applied (broker truth) and escalated as a reconciliation condition`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b, { qty: 75 });
    consumer.ingestStreamObservation(b.obs({ status: b.COMPLETE, filled: 100, avg: 13.0, stamp: "10:00:05" }));

    assert.equal(adapter.get(clientOrderId).filled_quantity, 100, "never clamped: the broker's number is the truth");
    assert.equal(consumer.projection().ledger(clientOrderId).overfill, 25, "and the excess is surfaced");
    assert.equal(
      consumer.diagnostics().overfillObservations,
      1,
      "an overfill means our own quantity model was wrong — an explicit reconciliation condition",
    );
  });

  test(`[${b.name}] a NEGATIVE quantity is impossible: never applied, and escalated`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 25, stamp: "10:00:01" }));
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: -5, stamp: "10:00:02" }));

    assert.equal(adapter.get(clientOrderId).filled_quantity, 25, "an impossible quantity changes nothing");
    assert.equal(consumer.diagnostics().invalidQuantityObservations, 1, "and is escalated, not ignored");
  });

  test(`[${b.name}] a MISSING quantity is not a confirmed zero`, () => {
    const { consumer, adapter, clientOrderId } = makeConsumer(b);
    consumer.ingestStreamObservation(b.obs({ status: b.OPEN, filled: 40, avg: 12.0, stamp: "10:00:01" }));
    // A terminal label with NO quantity field at all.
    consumer.ingestStreamObservation(b.obs({ status: b.COMPLETE, filled: undefined, stamp: "10:00:06" }));

    assert.equal(
      adapter.get(clientOrderId).filled_quantity,
      40,
      "absence of a quantity must never be read as a fill or as a zero",
    );
    assert.ok(consumer.diagnostics().absentEvidenceEvents >= 1, "it is recorded as insufficient evidence");
  });
}

/* ═══════════════ 9. restart and replay ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] after a RESTART, replaying the whole history rebuilds the same exposure exactly once`, () => {
    // A fresh process re-registers from durable intent (what the reconcile sweep does) and then sees
    // the broker's history replayed. Deduplication across the restart is carried by the broker's own
    // cumulative quantity, which is monotonic — not by remembered event ids, which are gone.
    const history = [
      { status: b.OPEN, filled: 0, stamp: "10:00:01" },
      { status: b.OPEN, filled: 25, avg: 12.0, stamp: "10:00:02" },
      { status: b.OPEN, filled: 50, avg: 12.2, stamp: "10:00:03" },
      { status: b.COMPLETE, filled: 75, avg: 12.4, stamp: "10:00:04" },
    ];

    const before = makeConsumer(b);
    for (const h of history) before.consumer.ingestStreamObservation(b.obs(h));
    assert.equal(before.adapter.get(before.clientOrderId).filled_quantity, 75);
    assert.equal(before.adapter.get(before.clientOrderId).state, "COMPLETE");
    const fillsBefore = before.adapter.get(before.clientOrderId).fills.length;

    // ── RESTART: a brand-new consumer and a brand-new ledger. ──
    const after = makeConsumer(b);
    for (const h of history) after.consumer.ingestRestObservation(b.obs(h), "reconciliation");
    // And the stream redelivers everything again on top of the replay.
    for (const h of history) after.consumer.ingestStreamObservation(b.obs(h));

    const order = after.adapter.get(after.clientOrderId);
    assert.equal(order.filled_quantity, 75, "the same final exposure, not 150");
    assert.equal(order.state, "COMPLETE");
    assert.equal(
      order.fills.length,
      fillsBefore,
      "replay plus redelivery creates no extra exposure: cumulative monotonicity is restart-safe",
    );
    assert.equal(after.consumer.workingOrderCount(), 0, "and the order is settled after the replay");
  });
}

/* ═══════════════ 10. the event identity must distinguish a TRANSITION from a REDELIVERY ═══════════════ */

test("[zerodha] OPEN(0) and CANCELLED(0) stamped in the SAME second are distinct events", () => {
  // Kite's exchange_update_timestamp is 1-second granular, so without the status in the event
  // identity these two share an id and the ledger discards the cancellation as a redelivery.
  const open = KITE.obs({ status: "OPEN", filled: 0, stamp: "2026-09-13 10:00:01" });
  const cancelled = KITE.obs({ status: "CANCELLED", filled: 0, stamp: "2026-09-13 10:00:01" });
  assert.notEqual(open.eventId, cancelled.eventId, "a status TRANSITION must not look like a redelivery");
  // A true redelivery repeats the status too, so it still deduplicates.
  const openAgain = KITE.obs({ status: "OPEN", filled: 0, stamp: "2026-09-13 10:00:01" });
  assert.equal(open.eventId, openAgain.eventId, "an identical redelivery is still one event");
});

test("[dhan] PENDING(0) and CANCELLED(0) stamped in the SAME second are distinct events", () => {
  const pending = DHAN.obs({ status: "PENDING", filled: 0, stamp: "2026-09-13 10:00:01" });
  const cancelled = DHAN.obs({ status: "CANCELLED", filled: 0, stamp: "2026-09-13 10:00:01" });
  assert.notEqual(pending.eventId, cancelled.eventId, "a status TRANSITION must not look like a redelivery");
  const pendingAgain = DHAN.obs({ status: "PENDING", filled: 0, stamp: "2026-09-13 10:00:01" });
  assert.equal(pending.eventId, pendingAgain.eventId, "an identical redelivery is still one event");
});

/* ═══════════════ 11. the idle detector consequence ═══════════════ */

for (const b of BROKERS) {
  test(`[${b.name}] a zero-fill cancellation stops the idle detector expecting events forever`, () => {
    // The compounding bug: a settled-but-still-"working" order made the idle detector demote a
    // healthy stream to DEGRADED, which refuses new entry — a self-inflicted outage.
    const adapter = new ContractAdapter();
    const clientOrderId = "BOX:T9:ENTRY:k1_ce:attempt-1";
    let now = 1_700_000_000_000;
    const consumer = new OrderStreamConsumer({
      broker: b.name,
      account: () => b.account,
      adapter,
      streamEnabled: true,
      expectedIdleMs: 5_000,
      reconcileSweep: async () => ({ synchronized: true }),
      now: () => now,
    });
    consumer.registerIntent({ clientOrderId, ownerTag: b.tag, account: b.account, requestedQty: 75 });
    adapter.register(clientOrderId, 75);
    consumer.onConnecting();
    consumer.onSocketOpen();
    consumer.onAuthenticated("broker_acknowledged");
    consumer.markSynchronized(consumer.connectionGeneration());
    assert.equal(consumer.lifecycleState(), "READY");

    consumer.ingestStreamObservation(b.obs({ status: b.CANCELLED, filled: 0, stamp: "10:00:04" }));
    assert.equal(consumer.workingOrderCount(), 0, "the dead order is no longer expected to report");

    // Long silence follows. With nothing working, silence is NORMAL.
    now += 60_000;
    consumer.evaluateIdle(now);
    assert.equal(
      consumer.lifecycleState(),
      "READY",
      "a healthy stream must not be demoted for not reporting on an order that is already dead",
    );
  });
}
