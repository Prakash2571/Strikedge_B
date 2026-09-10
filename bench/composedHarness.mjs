/**
 * COMPOSED-PATH HARNESS — drives the REAL production classes on the discrete-event scheduler.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT PATH THIS EXERCISES
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The task requires benchmarking the ACTUAL composed path, using the real classes, not
 * reimplementations:
 *
 *   BoxOrderManager.submit            (real — persistence-before-transport, queueing, concurrency)
 *      → MemoryPersistence            (real durable-write SEMANTICS + injectable PG-write delay)
 *      → KiteBrokerAdapter.submitOrder(real — pacer, waitForResolution, REST getOrder poll)
 *         → mock KITE TRANSPORT        (place/getOrder/cancel over the virtual clock)
 *         → mock ORDER-UPDATE STREAM   (delivers fills via OrderStreamConsumer.ingestStreamObservation)
 *      → OrderStreamConsumer           (real — projection + applyOrderUpdate wakes the waiter)
 *
 * The two named defects of the OLD benchmark are structurally impossible here because we run the
 * real code:
 *   1. "treats most POST responses as fill confirmation" — the real waiter only breaks on a
 *      broker-CONFIRMED terminal snapshot (COMPLETE/CANCELLED/REJECTED); an ACK (the POST
 *      response) is never a fill.
 *   2. "skips the ordinary REST confirmation" — the real `waitForResolution` calls
 *      `transport.getOrder(...)` on every poll; a healthy stream only makes the SAME confirmed
 *      truth arrive sooner, it never removes the REST confirmation path.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TIME BASE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The KiteBrokerAdapter, the OrderStreamConsumer clock and this harness's mocks all share ONE
 * injected discrete-event scheduler (bench/scheduler.mjs). Concurrent waits therefore OVERLAP.
 * The BoxOrderManager takes only a `{ now }` clock (it queues on microtasks, not timed waits), so
 * the manager's own logic is time-agnostic and honest on this clock.
 *
 * The Dhan adapter's poll/pacer use real `Date.now()`/`sleep`, so it cannot run on virtual time;
 * a separate real-timed harness (compositeRealTimed.mjs) exercises the real DhanBrokerAdapter.
 *
 * EVERY broker delay here is an ASSUMPTION (an INPUT we chose), never a measurement. See
 * `assumptions.mjs`.
 */

import { KiteBrokerAdapter } from "../dist/box/kiteBrokerAdapter.js";
import { OrderStreamConsumer } from "../dist/box/orderStreamConsumer.js";
import { stableKiteTag } from "../dist/box/kiteBrokerAdapter.js";
import { BoxOrderManager } from "../dist/box/orderManager.js";

import { createScheduler } from "./scheduler.mjs";
import { makeRng } from "./assumptions.mjs";

/* ─────────────────────────────── the four legs ─────────────────────────────── */

/**
 * HEDGE-FIRST transport order. The two BUY hedges (wave 0) must be CONFIRMED before the dependent
 * SELLs (wave 1) may transmit. Raising concurrency overlaps legs WITHIN a wave; it never overlaps
 * a SELL with the hedge it depends on. The BoxOrderManager enforces the real single-Box
 * concurrency; this list only fixes role identity and the wave dependency the caller sequences.
 */
export const LEGS = [
  { role: "k1_ce", side: "BUY", wave: 0 },
  { role: "k2_pe", side: "BUY", wave: 0 },
  { role: "k2_ce", side: "SELL", wave: 1 },
  { role: "k1_pe", side: "SELL", wave: 1 },
];

/* ─────────────────────────── durable persistence mock ─────────────────────────── */

const clone = (v) => structuredClone(v);
const IMMUTABLE = [
  "broker_mode", "trade_id", "attempt_id", "role", "purpose", "phase",
  "exchange", "tradingsymbol", "token", "side", "quantity",
  "reference_price", "tick_size", "max_chase_ticks", "limit_price",
];

/**
 * Durable-write mock with the REAL guarded-write semantics the production PostgreSQL/Mongo path
 * has (immutable-field guard, non-strict `$lte` cumulative-fill guard, expected-state guard,
 * pre-image `previous/current_filled_quantity` reporting) PLUS an injectable per-write delay on
 * the virtual clock, so the "PostgreSQL delay" scenario moves a real cost onto the critical path.
 *
 * This is the same shape used by tests/box/orderManager.test.mjs, extended only with the clock
 * so the benchmark can attribute persistence latency.
 */
export function makeDurablePersistence({ clock, createDelayMs = () => 0, updateDelayMs = () => 0 } = {}) {
  const rows = new Map();
  let createWaitTotal = 0;
  let updateWaitTotal = 0;
  return {
    _rows: rows,
    persistenceWaitMs: () => createWaitTotal + updateWaitTotal,
    async create(intent) {
      const d = createDelayMs();
      if (d > 0) { createWaitTotal += d; await clock.wait(d); }
      const current = rows.get(intent.client_order_id);
      if (current) {
        for (const k of IMMUTABLE) {
          if (current[k] !== intent[k]) throw new Error(`immutable mismatch: ${k}`);
        }
        return clone(current);
      }
      rows.set(intent.client_order_id, clone(intent));
      return clone(intent);
    },
    async update(clientOrderId, patch, audit, expectedStates) {
      const d = updateDelayMs();
      if (d > 0) { updateWaitTotal += d; await clock.wait(d); }
      const current = rows.get(clientOrderId);
      if (!current) return { intent: null, applied: false, previous_filled_quantity: null, current_filled_quantity: null };
      if (expectedStates && !expectedStates.includes(current.state)) {
        return { intent: clone(current), applied: false, previous_filled_quantity: current.filled_quantity, current_filled_quantity: current.filled_quantity };
      }
      if (patch.filled_quantity !== undefined && patch.filled_quantity < current.filled_quantity) {
        return { intent: clone(current), applied: false, previous_filled_quantity: current.filled_quantity, current_filled_quantity: current.filled_quantity };
      }
      const next = { ...current, ...clone(patch), previous_filled_quantity: current.filled_quantity };
      if (!next.audit) next.audit = [];
      if (!next.audit.some((it) => it.audit_id === audit.audit_id)) next.audit = [...next.audit, clone(audit)];
      rows.set(clientOrderId, next);
      return { intent: clone(next), applied: true, previous_filled_quantity: current.filled_quantity, current_filled_quantity: next.filled_quantity };
    },
    async loadNonterminal() {
      return [...rows.values()].filter((i) => !["COMPLETE", "CANCELLED", "REJECTED"].includes(i.state)).map(clone);
    },
    async loadOwned() { return [...rows.values()].map(clone); },
    async findByClientId(id) { return rows.has(id) ? clone(rows.get(id)) : null; },
    async findByBrokerId(id) {
      const f = [...rows.values()].find((i) => i.broker_order_id === id);
      return f ? clone(f) : null;
    },
  };
}

/* ─────────────────────────── mocked broker transport + stream ─────────────────────────── */

/**
 * A mock Kite transport whose response delays and fill trajectory are driven by the scheduler and
 * an assumed-delay sampler. It does NOT decide "filled" from the POST — it ACKs the POST and then
 * evolves the order's REST snapshot toward its terminal state over virtual time, exactly what a
 * real broker would surface on getOrder. A separate stream may deliver the same terminal sooner.
 *
 * `outcome` per leg drives the trajectory:
 *   { kind: "fill", fillAtMs, partial? }         — completes (optionally via a partial first)
 *   { kind: "reject", family }                   — broker rejects the placement
 *   { kind: "cancel", fillAtMs, filledQty }      — never completes; protective-cancel terminal
 */
export function makeKiteTransport({ clock, plan, assume, rand, onSend, onProgress }) {
  const state = new Map();       // brokerOrderId -> snapshot
  const byClient = new Map();     // tag -> brokerOrderId (planned outcome lookup uses tag)
  let placeCalls = 0;
  let getCalls = 0;
  let cancelCalls = 0;
  let nextId = 1;

  // Notify the runner that a broker order made observable progress (partial or terminal), so a
  // healthy stream can deliver the SAME confirmed truth sooner. Bounded: fires only on an actual
  // snapshot transition, never on a timer that re-arms itself.
  function progress(brokerOrderId) {
    const s = state.get(brokerOrderId);
    if (s) onProgress?.(s.tag, brokerOrderId, clone(s));
  }

  function snapshotFor(brokerOrderId) {
    return state.get(brokerOrderId);
  }

  return {
    placeCalls: () => placeCalls,
    getOrderCalls: () => getCalls,
    cancelCalls: () => cancelCalls,
    _state: state,
    async placeOrder(req, opts) {
      // Assumed POST latency (network + gateway + matching-engine ACK), an INPUT not a measurement.
      const postMs = assume.postMs(rand);
      opts?.beforeSend?.();
      placeCalls++;
      // The send instant is NOW — beforeSend fired at the true post-pacing send boundary.
      onSend?.(req.tag, clock.now());
      await clock.wait(postMs);
      const outcome = plan.outcomeForTag(req.tag);
      if (outcome?.kind === "reject") {
        // Simulate a definitive broker rejection at the transport (throws a rejection error).
        const err = new Error(`REJECT:${outcome.family ?? "generic"}`);
        err.kiteRejection = true;
        throw err;
      }
      const brokerOrderId = `K-${nextId++}`;
      byClient.set(req.tag, brokerOrderId);
      const snap = {
        order_id: brokerOrderId, status: "OPEN",
        exchange: req.exchange, tradingsymbol: req.tradingsymbol,
        transaction_type: req.transaction_type, quantity: req.quantity,
        filled_quantity: 0, pending_quantity: req.quantity, average_price: 0,
        price: req.price, tag: req.tag, status_message: null,
        order_timestamp: null, exchange_update_timestamp: null,
      };
      state.set(brokerOrderId, snap);
      // Schedule the fill/partial trajectory on the virtual clock. getOrder simply reports
      // whatever the trajectory has advanced the snapshot to by the time it is polled.
      const startedAt = clock.now();
      if (outcome?.kind === "fill") {
        const fillAt = startedAt + (outcome.fillAtMs ?? assume.fillMs(rand));
        if (outcome.partial) {
          const partialAt = startedAt + Math.min(outcome.partialAtMs ?? assume.partialFirstMs(rand), (fillAt - startedAt));
          clock.schedule(partialAt - startedAt, () => {
            const s = state.get(brokerOrderId);
            if (s && s.status === "OPEN") {
              const q = Math.floor(req.quantity / 2);
              s.filled_quantity = q; s.pending_quantity = req.quantity - q;
              s.average_price = req.price; s.status = "OPEN";
              progress(brokerOrderId);
            }
          });
        }
        clock.schedule(fillAt - startedAt, () => {
          const s = state.get(brokerOrderId);
          if (s && s.status !== "CANCELLED" && s.status !== "REJECTED") {
            s.filled_quantity = req.quantity; s.pending_quantity = 0;
            s.average_price = req.price; s.status = "COMPLETE";
            progress(brokerOrderId);
          }
        });
      } else if (outcome?.kind === "cancel") {
        // A working/partial order that will be protectively cancelled; the snapshot stays OPEN
        // (with an optional partial) until the adapter cancels it, then getOrder reports CANCELLED.
        const filled = outcome.filledQty ?? 0;
        if (filled > 0) {
          clock.schedule(outcome.fillAtMs ?? assume.partialFirstMs(rand), () => {
            const s = state.get(brokerOrderId);
            if (s && s.status === "OPEN") {
              s.filled_quantity = filled; s.pending_quantity = req.quantity - filled; s.average_price = req.price;
              progress(brokerOrderId);
            }
          });
        }
      }
      return { order_id: brokerOrderId };
    },
    async getOrder(orderId) {
      getCalls++;
      const s = snapshotFor(orderId);
      return s ? clone(s) : null;
    },
    async cancelOrder(orderId) {
      cancelCalls++;
      // Assumed cancel-ack latency, then the broker reports the terminal cumulative snapshot.
      await clock.wait(assume.cancelMs(rand));
      const s = state.get(orderId);
      if (s && s.status !== "COMPLETE") {
        s.status = "CANCELLED"; s.pending_quantity = 0;
        progress(orderId);
      }
    },
    async modifyOrder(orderId, req) {
      await clock.wait(assume.statusMs(rand));
      const s = state.get(orderId);
      if (s) s.price = req.price;
    },
    async listOrders() { return [...state.values()].map(clone); },
    async listPositions() { return []; },
    async margins() { return { available: 1e9, utilised: 0 }; },
    async health() { return { ok: true, transport: "up", authenticated: true, message: null, checked_at: clock.now() }; },
    /** Map a broker order id back to its tag (for the stream to attribute an event). */
    tagFor(orderId) { const s = state.get(orderId); return s ? s.tag : null; },
    brokerIdForTag(tag) { return byClient.get(tag) ?? null; },
  };
}
