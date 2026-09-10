/**
 * ASSUMED BROKER BEHAVIOUR — every value here is an INPUT WE CHOSE, not a measurement.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE QUOTING ANY BENCHMARK NUMBER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The offline benchmark measures OUR code: the real pacer, the real waitForResolution loop, the
 * real REST-poll cadence, the real persistence-before-transport ordering, the real order-stream
 * projection and wake path, and the real BoxOrderManager queueing/concurrency. It does NOT and
 * CANNOT measure the broker: queue position, matching-engine behaviour, the Mumbai network path,
 * TLS setup, gateway load and broker-side slowness are all UNKNOWN offline.
 *
 * So the response delays below are ASSUMPTIONS. They are deliberately pessimistic-but-plausible
 * for a Mumbai EC2 host talking to a Mumbai broker over warm TLS. Change any of them and every
 * output changes — which is exactly why they are declared here in one place and echoed into the
 * benchmark's own output and the doc, rather than buried.
 *
 * NOTHING here may ever be presented as measured live latency or as a guaranteed fill rate.
 */

/** The assumed distributions, exported so the report and the doc can print them verbatim. */
export const ASSUMPTIONS = {
  _label: "ASSUMED broker behaviour — INPUTS we chose, NOT measurements of any live broker.",
  /** Order POST → HTTP response (ACK) latency. */
  post_ms: { min: 40, p50: 70, p95: 160, outlier: 900, outlier_rate: 0.05 },
  /** A single REST getOrder read latency (network + gateway). */
  status_read_ms: { min: 30, p50: 50, p95: 90 },
  /** Time from ACK until the broker's REST snapshot shows a COMPLETE fill. */
  fill_after_ack_ms: { min: 60, p50: 180, p95: 650, outlier: 1800, outlier_rate: 0.04 },
  /** Time from ACK until a FIRST partial fill appears (for partial-fill scenarios). */
  partial_first_ms: { min: 40, p50: 110, p95: 380 },
  /** Cancel POST → cancel acknowledged latency. */
  cancel_ms: { min: 40, p50: 80, p95: 200 },
  /**
   * When a HEALTHY order-update stream is armed, how long after the broker reaches a terminal
   * state the push event is delivered to us. A stream makes the SAME confirmed truth arrive
   * SOONER than the next REST poll would; it never invents a new truth. Assumed small.
   */
  stream_delivery_ms: { min: 5, p50: 15, p95: 45 },
  /** Durable PostgreSQL intent write (create + each guarded update) — a real, unavoidable cost. */
  pg_intent_write_ms: { min: 2, p50: 4, p95: 12 },
  /** The DEGRADED PostgreSQL-delay scenario replaces the write cost with this slower profile. */
  pg_intent_write_slow_ms: { min: 40, p50: 90, p95: 250 },
  /** Fraction of entries in which a leg comes back partially filled before completing. */
  partial_fill_rate: 0.20,
  /** Fraction of POSTs that hit a rate-limit cooldown (429 + Retry-After) at the transport. */
  rate_limit_rate: 0.03,
  retry_after_ms: 1000,
};

/** Deterministic LCG PRNG so runs are reproducible and identical seeds are comparable. */
export function makeRng(seed = 20260910) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Sample a delay from a min/p50/p95 triple with an optional outlier tail. Throws on a bad spec. */
export function sampleDelay(spec, rand) {
  if (!Number.isFinite(spec?.min) || !Number.isFinite(spec?.p50) || !Number.isFinite(spec?.p95)) {
    throw new Error(`malformed delay spec (needs finite min/p50/p95): ${JSON.stringify(spec)}`);
  }
  let v;
  if (spec.outlier !== undefined && rand() < spec.outlier_rate) {
    v = spec.outlier;
  } else {
    const u = rand();
    if (u < 0.5) v = spec.min + (spec.p50 - spec.min) * (u / 0.5);
    else if (u < 0.95) v = spec.p50 + (spec.p95 - spec.p50) * ((u - 0.5) / 0.45);
    else v = spec.p95 * (1 + (u - 0.95) * 4);
  }
  if (!Number.isFinite(v)) throw new Error(`sampled a non-finite delay from ${JSON.stringify(spec)}`);
  return Math.round(v);
}

/**
 * A sampler bound to one RNG and (optionally) an overridden pg-write profile (PostgreSQL-delay
 * scenario). All methods return whole ms.
 */
export function makeAssume(overrides = {}) {
  const A = { ...ASSUMPTIONS, ...overrides };
  return {
    raw: A,
    postMs: (r) => sampleDelay(A.post_ms, r),
    statusMs: (r) => sampleDelay(A.status_read_ms, r),
    fillMs: (r) => sampleDelay(A.fill_after_ack_ms, r),
    partialFirstMs: (r) => sampleDelay(A.partial_first_ms, r),
    cancelMs: (r) => sampleDelay(A.cancel_ms, r),
    streamMs: (r) => sampleDelay(A.stream_delivery_ms, r),
    pgWriteMs: (r) => sampleDelay(A.pg_intent_write_ms, r),
    partialFillRate: A.partial_fill_rate,
    rateLimitRate: A.rate_limit_rate,
    retryAfterMs: A.retry_after_ms,
  };
}
