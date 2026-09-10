/**
 * ENTRY RUNNER — one four-leg box entry through the composed production path under a scenario.
 *
 * Produces a span breakdown for ONE entry. The caller repeats it with identical seeds across
 * configurations so the comparison is meaningful.
 *
 * Metrics recorded (all on the shared virtual clock, all in ms):
 *   detection_to_first_send_ms  — admission instant → first leg's POST leaves the wire
 *   first_to_last_send_ms       — first POST → last POST (leg-transmission dispersion)
 *   first_fill_ms               — admission → first CONFIRMED fill observed on any leg
 *   four_leg_completion_ms      — admission → every leg terminal (COMPLETE/CANCELLED)
 *   cancel_to_terminal_ms       — for cancelled legs: cancel-request → terminal confirmation
 *   fill_dispersion_ms          — first terminal → last terminal
 *   persistence_wait_ms         — durable PG create+update cost on the critical path
 *   pacing_wait_ms              — adapter pacer wait (order-mutation + general)
 *   rest_polls / stream_events  — how confirmation actually arrived (proves REST is not skipped)
 *   completed / partial / cancelled / rejected — honest outcome accounting per entry
 */

import { KiteBrokerAdapter, stableKiteTag } from "../dist/box/kiteBrokerAdapter.js";
import { OrderStreamConsumer } from "../dist/box/orderStreamConsumer.js";
import { BoxOrderManager } from "../dist/box/orderManager.js";

import { createScheduler } from "./scheduler.mjs";
import { makeAssume, makeRng, sampleDelay } from "./assumptions.mjs";
import { LEGS, makeDurablePersistence, makeKiteTransport } from "./composedHarness.mjs";

const TRADE = "bench-trade";
const ROLE_TOKEN = { k1_ce: 1001, k2_pe: 1002, k2_ce: 1003, k1_pe: 1004 };

function legRequest(leg, attempt) {
  const clientOrderId = `BOX:${TRADE}:ENTRY:${leg.role}:${attempt}`;
  return {
    client_order_id: clientOrderId,
    role: leg.role,
    trade_id: TRADE,
    attempt_id: attempt,
    purpose: "ENTRY",
    phase: "entry",
    exchange: "NFO",
    tradingsymbol: `NIFTY-${leg.role}`,
    token: ROLE_TOKEN[leg.role],
    side: leg.side,
    quantity: 75,
    pricing: {
      order_type: "LIMIT",
      reference_price: 100,
      tick_size: 0.05,
      max_chase_ticks: 2,
      limit_price: leg.side === "BUY" ? 100.1 : 99.9,
    },
  };
}

/**
 * Decide each leg's broker outcome for THIS entry from the assumed rates and the seeded RNG.
 * Deterministic given the RNG stream, so identical seeds ⇒ identical outcomes across configs.
 */
function planOutcomes(scenario, assume, rand) {
  const byTag = new Map();
  for (const leg of LEGS) {
    const tag = stableKiteTag(`BOX:${TRADE}:ENTRY:${leg.role}:${scenario.attempt}`);
    let outcome;
    const roll = rand();
    if (scenario.forceReject && leg.role === scenario.forceReject) {
      outcome = { kind: "reject", family: "price_band" };
    } else if (scenario.forceCancel && leg.role === scenario.forceCancel) {
      outcome = { kind: "cancel", filledQty: scenario.cancelPartialQty ?? 0, fillAtMs: assume.partialFirstMs(rand) };
    } else if (roll < assume.partialFillRate) {
      outcome = { kind: "fill", partial: true, partialAtMs: assume.partialFirstMs(rand), fillAtMs: assume.fillMs(rand) };
    } else {
      outcome = { kind: "fill", fillAtMs: assume.fillMs(rand) };
    }
    byTag.set(tag, outcome);
  }
  return { outcomeForTag: (tag) => byTag.get(tag) };
}

/**
 * Wire the real BoxOrderManager + KiteBrokerAdapter + OrderStreamConsumer + durable persistence,
 * all on ONE discrete-event scheduler, and run one four-leg entry.
 */
export async function runComposedEntry({ scenario, seed }) {
  const clock = createScheduler(0);
  const rng = makeRng(seed);
  const assume = makeAssume(scenario.assumptionOverrides ?? {});

  // Durable persistence with the scenario's PG-write profile.
  const pgProfile = scenario.pgDelay ? assume.raw.pg_intent_write_slow_ms : assume.raw.pg_intent_write_ms;
  const persistence = makeDurablePersistence({
    clock,
    createDelayMs: () => sampleDelay(pgProfile, rng),
    updateDelayMs: () => sampleDelay(pgProfile, rng),
  });

  const plan = planOutcomes(scenario, assume, rng);
  // Send instants captured at the true post-pacing send boundary, keyed by tag.
  const sendAtByTag = new Map();
  // Late-bound progress handler: the transport notifies broker progress here; the runner (once the
  // consumer exists) forwards it as a stream event. Kept in a holder so the transport can be built
  // before the consumer without a circular reference.
  const progressHandler = { fn: null };
  const transport = makeKiteTransport({
    clock, plan, assume, rand: rng,
    onSend: (tag, at) => { if (!sendAtByTag.has(tag)) sendAtByTag.set(tag, at); },
    onProgress: (tag, brokerId, snap) => progressHandler.fn?.(tag, brokerId, snap),
  });

  const adapter = new KiteBrokerAdapter(
    transport,
    {
      executionMode: "live", enabled: true,
      brokerMinIntervalMs: 110, // zerodha order-mutation floor
      ackTimeoutMs: 5_000, workingTimeoutMs: 8_000, partialTimeoutMs: 4_000, cancelTimeoutMs: 3_000,
      maxChaseTicks: 2, maxModifications: 2,
    },
    { now: () => clock.now(), wait: (ms) => clock.wait(ms) },
  );

  const streamEnabled = scenario.stream !== "off";
  const consumer = new OrderStreamConsumer({
    broker: "zerodha",
    account: () => "AB1234",
    adapter,
    streamEnabled,
    now: () => clock.now(),
  });

  const sendAt = [];
  const terminalAt = [];
  let firstFillAt = null;
  let completed = 0, partial = 0, cancelled = 0, rejected = 0;

  const manager = new BoxOrderManager({
    adapter,
    orderStreamConsumer: consumer,
    persistence,
    limits: {
      maxOpenBoxes: 10, maxConcurrentExecutions: scenario.concurrency, maxResidualLegs: 10,
      dailyLossLimit: 1e9, rejectLimit: 1000, consecutiveFailureLimit: 1000,
      maxOpenLegQuantity: 100000, maxGrossOpenLegQuantity: 1000000,
      reconcileIntervalMs: 1e9, feedReconnectWarmupMs: 0,
    },
    controls: { entryEnabled: true, liveOrderEnabled: true, emergencyFlatten: true },
    clock: { now: () => clock.now() },
    istDayKey: () => "2026-09-10",
  });
  manager.seedLimits({ tradingDay: "2026-09-10" });
  manager.setFeedHealthy(true);
  // Open the entry gates the way production does: a reconcile establishes persistence/daily-risk/
  // broker-API/reconciliation health. Adapter reads (health/listOrders/listPositions) are healthy
  // mocks, so this settles quickly on the virtual clock.
  {
    const rec = manager.reconcile();
    await clock.drain({ stopWhen: () => false });
    await rec;
  }

  // A healthy stream delivers the SAME confirmed terminal SOONER than the next REST poll would.
  // Driven by TRANSPORT PROGRESS notifications (bounded — one per real snapshot transition), NOT a
  // self-rescheduling poll. When the stream is disconnected (flap window) or off, no event is
  // delivered and the REAL REST poll remains the only confirmation path.
  progressHandler.fn = (tag, brokerId, snap) => {
    if (!streamEnabled) return;
    const disconnected = scenario.stream === "flap"
      && clock.now() >= (scenario.flapFromMs ?? 300)
      && clock.now() < (scenario.flapUntilMs ?? 900);
    if (disconnected) return; // stream is down: the REST poll will confirm instead
    clock.schedule(assume.streamMs(rng), () => {
      consumer.ingestStreamObservation({
        ownerTag: tag, brokerOrderId: brokerId, account: "AB1234",
        cumulativeQty: snap.filled_quantity, quantityPresent: true,
        averagePrice: snap.average_price, rawStatus: snap.status,
        eventId: `${brokerId}:${snap.status}:${snap.filled_quantity}`,
      });
    });
  };

  async function submitLeg(leg) {
    const req = legRequest(leg, scenario.attempt);
    const tag = stableKiteTag(req.client_order_id);
    let order;
    try {
      order = await manager.submit(req);
    } catch (err) {
      rejected++;
      return { role: leg.role, error: String(err?.message ?? err) };
    }
    const sent = sendAtByTag.get(tag);
    if (sent !== undefined) sendAt.push(sent);
    if (order.state === "COMPLETE") completed++;
    else if (order.state === "CANCELLED") cancelled++;
    else if (order.state === "PARTIALLY_FILLED") partial++;
    if ((order.filled_quantity ?? 0) > 0 && firstFillAt === null) firstFillAt = clock.now();
    terminalAt.push(clock.now());
    return { role: leg.role, state: order.state, filled: order.filled_quantity };
  }

  // Drive the manager pump + scheduler together. The submit promises resolve as the scheduler
  // advances; we drain until all four legs settle.
  const results = [];
  const admittedAt = clock.now();

  // Wave 0: the two BUY hedges. Wave 1 (SELLs) only after both hedges CONFIRMED (hedge-first).
  const wave0 = LEGS.filter((l) => l.wave === 0);
  const wave1 = LEGS.filter((l) => l.wave === 1);

  const w0 = wave0.map((leg) => submitLeg(leg));
  // Advance virtual time until wave 0 promises settle.
  const w0settled = Promise.allSettled(w0);
  await clock.drain({ stopWhen: () => false });
  const w0res = await w0settled;
  results.push(...w0res.map((r) => (r.status === "fulfilled" ? r.value : { error: String(r.reason?.message ?? r.reason) })));

  // Only transmit the dependent SELLs if BOTH hedges completed (hedge-first barrier). Otherwise
  // the entry is abandoned honestly — a partial box, not a hidden success.
  const hedgesOk = w0res.every((r) => r.status === "fulfilled" && r.value.state === "COMPLETE");
  if (hedgesOk) {
    const w1 = wave1.map((leg) => submitLeg(leg));
    const w1settled = Promise.allSettled(w1);
    await clock.drain({ stopWhen: () => false });
    const w1res = await w1settled;
    results.push(...w1res.map((r) => (r.status === "fulfilled" ? r.value : { error: String(r.reason?.message ?? r.reason) })));
  }

  const t0 = admittedAt;
  const spanFirstSend = sendAt.length ? Math.min(...sendAt) - t0 : null;
  const spanLastSend = sendAt.length ? Math.max(...sendAt) - t0 : null;

  const legsTransmitted = sendAt.length;
  const fourLegComplete = completed === 4;

  return {
    scenario: scenario.name,
    concurrency: scenario.concurrency,
    detection_to_first_send_ms: spanFirstSend,
    first_to_last_send_ms: (spanFirstSend !== null && spanLastSend !== null) ? spanLastSend - spanFirstSend : null,
    first_fill_ms: firstFillAt !== null ? firstFillAt - t0 : null,
    four_leg_completion_ms: fourLegComplete ? (terminalAt.length ? Math.max(...terminalAt) - t0 : null) : null,
    fill_dispersion_ms: terminalAt.length >= 2 ? Math.max(...terminalAt) - Math.min(...terminalAt) : 0,
    persistence_wait_ms: persistence.persistenceWaitMs(),
    pacing_wait_ms: adapter.pacingStats().totalWaitMs,
    order_mutation_wait_ms: adapter.pacingStats().orderMutationWaitMs,
    rest_polls: transport.getOrderCalls(),
    stream_events: adapter.streamObservationStats?.().applied ?? 0,
    legs_transmitted: legsTransmitted,
    completed, partial, cancelled, rejected,
    four_leg_completed: fourLegComplete,
    hedges_ok: hedgesOk,
    results,
  };
}
