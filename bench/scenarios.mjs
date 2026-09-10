/**
 * SCENARIO CATALOGUE for the composed-path benchmark.
 *
 * Every scenario is run at concurrency 1, 2 and 4 with the SAME seed sequence, so a comparison
 * across concurrencies (or across scenarios at a fixed concurrency) is meaningful. A scenario is a
 * small declarative object consumed by bench/runner.mjs.
 *
 * Scenario knobs:
 *   stream: "healthy" | "off" | "flap"   — order-update stream posture
 *   pgDelay: boolean                     — swap the slow PostgreSQL-write profile onto the path
 *   forceCancel: role, cancelPartialQty  — force a leg to be protectively cancelled (partial+cancel)
 *   forceReject: role                    — force a leg's placement to be rejected by the broker
 *   assumptionOverrides: {...}           — replace assumed delay specs (delayed fills, rate limits)
 *   flapFromMs/flapUntilMs               — the window during which a flapping stream is down
 *
 * NONE of these change OUR code; they change the ASSUMED broker/environment behaviour the real
 * code runs against.
 */

import { ASSUMPTIONS } from "./assumptions.mjs";

export const SCENARIOS = [
  {
    key: "healthy_stream",
    title: "Healthy order stream (push confirms fills; REST is the fallback)",
    build: () => ({ stream: "healthy" }),
  },
  {
    key: "rest_fallback",
    title: "REST fallback only (order stream OFF — every fill confirmed by REST poll)",
    build: () => ({ stream: "off" }),
  },
  {
    key: "stream_flap",
    title: "Stream disconnect/reconnect mid-entry (down 300–900ms; REST covers the gap)",
    build: () => ({ stream: "flap", flapFromMs: 300, flapUntilMs: 900 }),
  },
  {
    key: "delayed_fills",
    title: "Delayed fills (slower assumed fill-after-ack distribution)",
    build: () => ({
      stream: "healthy",
      assumptionOverrides: {
        fill_after_ack_ms: { min: 300, p50: 700, p95: 1800, outlier: 3500, outlier_rate: 0.05 },
      },
    }),
  },
  {
    key: "partial_and_cancel",
    title: "Partial fill then protective cancel on one dependent leg",
    build: () => ({ stream: "healthy", forceCancel: "k2_ce", cancelPartialQty: 35 }),
  },
  {
    key: "rate_limited",
    title: "Elevated rate-limit pressure (assumed 25% of POSTs hit a 429 cooldown)",
    build: () => ({
      stream: "healthy",
      assumptionOverrides: { rate_limit_rate: 0.25 },
    }),
  },
  {
    key: "pg_delay",
    title: "PostgreSQL write delay (slow durable-intent profile on the critical path)",
    build: () => ({ stream: "healthy", pgDelay: true }),
  },
  {
    key: "updates_precede_ack",
    title: "Order-update precedes HTTP acknowledgement (tiny stream latency, larger POST latency)",
    build: () => ({
      stream: "healthy",
      assumptionOverrides: {
        post_ms: { min: 200, p50: 300, p95: 500, outlier: 900, outlier_rate: 0.05 },
        fill_after_ack_ms: { min: 5, p50: 20, p95: 60 },
        stream_delivery_ms: { min: 1, p50: 3, p95: 8 },
      },
    }),
  },
];

/** The assumptions block echoed into the report so no number is quoted without its inputs. */
export const REPORTED_ASSUMPTIONS = ASSUMPTIONS;
