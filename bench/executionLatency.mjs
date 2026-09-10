/**
 * ⚠️ SUPERSEDED (item 9). This is the OLD pacing-only benchmark. It is retained ONLY for
 * reference/comparison and MUST NOT be quoted. It has three known flaws, documented in
 * docs/LATENCY_BENCHMARK.md §1:
 *   1. it treats most POST responses as fill confirmation (line ~195: confirmedAt = respondedAt);
 *   2. it skips the ordinary REST getOrder confirmation the real adapters perform;
 *   3. its virtual clock SUMS concurrent waits (line ~51: t += delta), so two concurrent 100ms
 *      waits complete at t=200 instead of t=100 — inflating every concurrency-2/4 figure.
 * Use `node bench/composedLatency.mjs`, which drives the REAL composed production path on a
 * correct discrete-event scheduler. See docs/LATENCY_BENCHMARK.md.
 *
 * OFFLINE EXECUTION-LATENCY BENCHMARK — entry concurrency 1 vs 2 vs 4.
 *
 * WHAT THIS IS: a deterministic, virtual-clock simulation of the four-leg entry path that
 * exercises the REAL pacing arithmetic (`TransportPacer`, `resolveBrokerPacing`, the real
 * per-broker profiles) against MOCKED broker response delays, partial fills and rate-limit
 * cooldowns. Every number it prints is therefore a property of OUR code plus an ASSUMED
 * broker response distribution.
 *
 * WHAT THIS IS EMPHATICALLY NOT: a prediction of live latency or fill rate. The broker's
 * queue position, matching-engine behaviour, network path and load are not modelled and
 * cannot be. Any figure here labelled "simulated" must never be quoted as a measured live
 * result. Only the pacing/queueing/serialisation components are real code under test; the
 * response delays are inputs we chose.
 *
 * Run:  node bench/executionLatency.mjs
 *       node bench/executionLatency.mjs --json    (machine-readable, for the report)
 *
 * No network. No broker. No database. Pure arithmetic on a virtual clock.
 */

import {
  TransportPacer,
  resolveBrokerPacing,
  burstPacingBudgetMs,
} from "../dist/box/brokerPacing.js";

/* ------------------------------- virtual clock ------------------------------ */

/**
 * A virtual clock whose `wait` jumps time forward instead of sleeping.
 *
 * This is what makes the benchmark deterministic AND instant: the real pacer's FIFO
 * chain and interval arithmetic run unmodified, but 120 ms of pacing costs no real time.
 * `now` is monotonic by construction, matching the monotonic discipline the transport
 * layer requires.
 */
function virtualClock(start = 0) {
  let t = start;
  const timeline = [];
  // A non-finite advance would poison `t` and every span derived from it, while the report
  // still printed plausible percentiles from whatever survived. Fail loudly instead.
  const guard = (ms, where) => {
    if (!Number.isFinite(ms)) throw new Error(`non-finite clock ${where}: ${ms}`);
    return Math.max(0, ms);
  };
  return {
    now: () => t,
    wait: async (ms) => {
      const delta = guard(ms, "wait");
      if (delta > 0) t += delta;
      // Yield so interleaved async work observes the advanced clock, exactly as it
      // would across a real await boundary.
      await Promise.resolve();
    },
    /** Advance without yielding — used to model a response arriving after N ms. */
    advance: (ms) => { t += guard(ms, "advance"); },
    mark: (label) => timeline.push({ label, at: t }),
    timeline,
  };
}

/* ------------------------------ scenario inputs ----------------------------- */

/**
 * ASSUMED broker behaviour. These are INPUTS, not measurements.
 *
 * The delays are deliberately pessimistic-but-plausible for a Mumbai EC2 host talking to
 * a Mumbai broker endpoint over TLS: an order POST that returns in 40-160 ms, a status read
 * in 30-90 ms, and an occasional 900 ms outlier standing in for a GC pause, a TLS
 * renegotiation or broker-side slowness. Change them and every output changes — which is
 * exactly why they are stated here rather than buried.
 */
const ASSUMPTIONS = {
  post_ms: { min: 40, p50: 70, p95: 160, outlier: 900, outlier_rate: 0.05 },
  status_read_ms: { min: 30, p50: 50, p95: 90 },
  /** Fraction of legs that come back partially filled and need a follow-up observation. */
  partial_fill_rate: 0.20,
  /** Fraction of POSTs that hit a rate-limit cooldown (429 + Retry-After). */
  rate_limit_rate: 0.03,
  retry_after_ms: 1000,
  /** Durable PostgreSQL intent write before any transport call (real, unavoidable). */
  pg_intent_write_ms: { min: 2, p50: 4, p95: 12 },
  /** Local evaluation + admission (coherence, capital, single-lot, reservation). */
  admission_ms: { min: 1, p50: 2, p95: 6 },
};

/** Deterministic PRNG so runs are reproducible. */
function rng(seed = 20260909) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * Sample a delay from a min/p50/p95 triple with an optional outlier tail.
 *
 * THROWS on a malformed spec rather than returning NaN. A NaN delay silently poisons the
 * virtual clock and every span derived from it, and the report would still print
 * confident-looking percentiles computed from the few surviving runs. A benchmark that
 * lies quietly is worse than one that fails, so this fails.
 */
function sampleDelay(spec, rand) {
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
  return v;
}

/* --------------------------- the four-leg entry run ------------------------- */

/**
 * HEDGE-FIRST TRANSPORT ORDER, preserved at every concurrency.
 *
 * The two BUY hedges must be CONFIRMED before the dependent SELLs may transmit (item 1's
 * barrier). So raising entry concurrency can overlap the two hedges with each other, and
 * later the two SELLs with each other, but it can NEVER overlap a SELL with the hedge it
 * depends on. That dependency is why concurrency 4 does not make four-leg execution
 * atomic and does not collapse the critical path to a single round trip.
 */
const LEGS = [
  { role: "k1_ce", side: "BUY", hedge: true, wave: 0 },
  { role: "k2_pe", side: "BUY", hedge: true, wave: 0 },
  { role: "k2_ce", side: "SELL", hedge: false, wave: 1 },
  { role: "k1_pe", side: "SELL", hedge: false, wave: 1 },
];

/**
 * Simulate ONE four-leg entry at a given entry concurrency.
 *
 * Returns the span breakdown. `first_to_last_submit_ms` and `four_leg_completion_ms` are
 * the two figures that actually matter for legging risk: how long the four orders are
 * spread over, and how long until every leg is confirmed.
 */
async function runEntry({ broker, concurrency, rand, generalIntervalMs = 250 }) {
  const clock = virtualClock(0);
  const pacing = resolveBrokerPacing(broker, generalIntervalMs, 0);
  const pacer = new TransportPacer(pacing, clock);

  const t0 = clock.now();
  // Local, pre-transport work: evaluation + admission gates, then the durable intent write.
  clock.advance(sampleDelay(ASSUMPTIONS.admission_ms, rand));
  const admittedAt = clock.now();

  const submitAts = [];
  const confirmAts = [];
  let rateLimitCooldownMs = 0;

  // Waves enforce the hedge-first dependency. Within a wave, `concurrency` legs may be
  // in flight together; across waves, wave 1 cannot start until wave 0 is CONFIRMED.
  for (const wave of [0, 1]) {
    const waveLegs = LEGS.filter((l) => l.wave === wave);
    // Effective in-flight width for this wave: never more than the wave has legs, and
    // never more than the configured entry concurrency.
    const width = Math.max(1, Math.min(concurrency, waveLegs.length));

    for (let i = 0; i < waveLegs.length; i += width) {
      const batch = waveLegs.slice(i, i + width);
      const results = await Promise.all(batch.map(async () => {
        // Durable intent BEFORE transport, while the slot is held (real critical path).
        clock.advance(sampleDelay(ASSUMPTIONS.pg_intent_write_ms, rand));
        // REAL pacing arithmetic via the pacer's own FIFO chain: code under test, not a mock.
        // `run` applies the interval wait and THEN invokes the operation, so `sentAt` read
        // inside the callback is the true post-pacing send instant.
        let sentAt = 0;
        const respondedAt = await pacer.run(async () => {
          sentAt = clock.now();
          let post = sampleDelay(ASSUMPTIONS.post_ms, rand);
          // A rate-limit cooldown is NOT a retry of the mutation — the order is never
          // replayed. It delays the NEXT placement, which is what the real budget does.
          if (rand() < ASSUMPTIONS.rate_limit_rate) {
            rateLimitCooldownMs += ASSUMPTIONS.retry_after_ms;
            post += ASSUMPTIONS.retry_after_ms;
          }
          clock.advance(post);
          return clock.now();
        }, "order_mutation");

        // A partial fill needs at least one more authoritative observation before the
        // cumulative quantity is confirmed. This is the cost item 6's order-update
        // stream is designed to remove: with a stream, confirmation arrives push-side
        // instead of costing another paced REST read.
        let confirmedAt = respondedAt;
        if (rand() < ASSUMPTIONS.partial_fill_rate) {
          confirmedAt = await pacer.run(async () => {
            clock.advance(sampleDelay(ASSUMPTIONS.status_read_ms, rand));
            return clock.now();
          }, "general");
        }
        return { sentAt, confirmedAt };
      }));
      for (const r of results) {
        submitAts.push(r.sentAt);
        confirmAts.push(r.confirmedAt);
      }
    }
  }

  const stats = pacer.stats();
  return {
    admission_ms: admittedAt - t0,
    first_submit_ms: Math.min(...submitAts) - t0,
    last_submit_ms: Math.max(...submitAts) - t0,
    first_to_last_submit_ms: Math.max(...submitAts) - Math.min(...submitAts),
    four_leg_completion_ms: Math.max(...confirmAts) - t0,
    fill_dispersion_ms: Math.max(...confirmAts) - Math.min(...confirmAts),
    pacing_wait_ms: stats.totalWaitMs,
    order_mutation_wait_ms: stats.orderMutationWaitMs,
    rate_limit_cooldown_ms: rateLimitCooldownMs,
    pacing_floor_ms: burstPacingBudgetMs(pacing, LEGS.length),
    order_min_interval_ms: pacing.orderMutationMinIntervalMs,
  };
}

/* --------------------------------- reporting -------------------------------- */

function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

function summarise(runs, key) {
  const vals = runs.map((r) => r[key]).filter((v) => Number.isFinite(v));
  // Rounded to whole ms: sub-millisecond precision here would be false precision, since
  // the inputs are assumed distributions rather than measurements.
  const r = (v) => (v === null ? null : Math.round(v));
  return {
    samples: vals.length,
    p50: r(percentile(vals, 0.5)),
    p95: r(percentile(vals, 0.95)),
    p99: r(percentile(vals, 0.99)),
    max: vals.length ? Math.round(Math.max(...vals)) : null,
  };
}

async function main() {
  const json = process.argv.includes("--json");
  const ITERATIONS = 500;
  const report = { assumptions: ASSUMPTIONS, iterations: ITERATIONS, results: {} };

  for (const broker of ["zerodha", "dhan"]) {
    report.results[broker] = {};
    for (const concurrency of [1, 2, 4]) {
      const rand = rng(20260909 + concurrency);
      const runs = [];
      for (let i = 0; i < ITERATIONS; i++) {
        runs.push(await runEntry({ broker, concurrency, rand }));
      }
      report.results[broker][`concurrency_${concurrency}`] = {
        first_to_last_submit_ms: summarise(runs, "first_to_last_submit_ms"),
        four_leg_completion_ms: summarise(runs, "four_leg_completion_ms"),
        fill_dispersion_ms: summarise(runs, "fill_dispersion_ms"),
        pacing_wait_ms: summarise(runs, "pacing_wait_ms"),
        order_min_interval_ms: runs[0].order_min_interval_ms,
        pacing_floor_ms: runs[0].pacing_floor_ms,
      };
    }
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("OFFLINE EXECUTION-LATENCY BENCHMARK (SIMULATED — not live measurement)");
  console.log(`iterations per cell: ${ITERATIONS}   virtual clock, real pacing arithmetic\n`);
  for (const broker of Object.keys(report.results)) {
    console.log(`── ${broker.toUpperCase()} ──  order min interval: ` +
      `${report.results[broker].concurrency_1.order_min_interval_ms}ms  ` +
      `4-leg pacing floor: ${report.results[broker].concurrency_1.pacing_floor_ms}ms`);
    console.log("  conc | first→last submit p50/p95/p99 | four-leg completion p50/p95/p99 | fill disp p95 | n");
    for (const c of [1, 2, 4]) {
      const r = report.results[broker][`concurrency_${c}`];
      const f = (s) => `${String(s.p50).padStart(5)}/${String(s.p95).padStart(5)}/${String(s.p99).padStart(5)}`;
      console.log(`   ${c}   | ${f(r.first_to_last_submit_ms)}          | ${f(r.four_leg_completion_ms)}           |` +
        ` ${String(r.fill_dispersion_ms.p95).padStart(6)}        | ${r.first_to_last_submit_ms.samples}`);
    }
    console.log();
  }
  console.log("READ THIS BEFORE QUOTING ANY NUMBER ABOVE:");
  console.log("  * Response delays, partial-fill rate and rate-limit rate are ASSUMPTIONS (see top of file),");
  console.log("    not measurements. Only pacing/queueing/serialisation is real code under test.");
  console.log("  * Hedge-first dependency is preserved at every concurrency: the two dependent SELLs");
  console.log("    cannot transmit until both BUY hedges are confirmed. Concurrency 4 therefore does");
  console.log("    NOT make four-leg execution atomic — it overlaps within a wave only.");
  console.log("  * Live latency and fill rates require actual supervised broker observations.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
