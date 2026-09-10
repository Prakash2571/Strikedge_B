/**
 * OFFLINE COMPOSED-PATH EXECUTION BENCHMARK — the REAL production classes on a correct
 * discrete-event scheduler, against ASSUMED broker delays.
 *
 * Run:
 *   node bench/composedLatency.mjs                 human-readable report
 *   node bench/composedLatency.mjs --json          machine-readable (for the doc)
 *   node bench/composedLatency.mjs --iterations=N  override iterations per cell (default 300)
 *
 * This benchmark exercises BoxOrderManager -> MemoryPersistence -> KiteBrokerAdapter (real pacer,
 * real waitForResolution, real REST getOrder confirmation) -> mocked transport + mocked
 * order-update stream -> OrderStreamConsumer projection. It reports meaningful DISTRIBUTIONS
 * (p50/p95/max), not just means, plus how confirmation actually arrived (REST polls vs stream
 * events) so the report cannot silently claim a stream removed the REST path.
 *
 * EVERY broker delay is an ASSUMPTION — see the ASSUMPTIONS block echoed below. No number here is
 * a measured Mumbai broker latency and no success rate here is guaranteed. See the honesty
 * section printed at the end and docs/LATENCY_BENCHMARK.md.
 */

import { runComposedEntry } from "./runner.mjs";
import { SCENARIOS, REPORTED_ASSUMPTIONS } from "./scenarios.mjs";

const CONCURRENCIES = [1, 2, 4];
/** One base seed per (scenario, concurrency); iteration i uses base+i, IDENTICAL across configs. */
const SEED_BASE = 20260910;

function percentile(values, p) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

function summarise(runs, key) {
  const vals = runs.map((r) => r[key]).filter((v) => Number.isFinite(v));
  const r = (v) => (v === null ? null : Math.round(v));
  return {
    samples: vals.length,
    p50: r(percentile(vals, 0.5)),
    p95: r(percentile(vals, 0.95)),
    max: vals.length ? Math.round(Math.max(...vals)) : null,
  };
}

/** A compact fixed-bucket histogram over the four-leg completion times (ms), for distribution. */
function histogram(values, edges = [250, 500, 1000, 1500, 2000, 3000, 5000]) {
  const buckets = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let i = edges.findIndex((e) => v <= e);
    if (i === -1) i = edges.length;
    buckets[i]++;
  }
  const labels = [];
  for (let i = 0; i < edges.length; i++) labels.push(`≤${edges[i]}`);
  labels.push(`>${edges[edges.length - 1]}`);
  return { labels, buckets };
}

async function runCell(scenario, concurrency, iterations) {
  const runs = [];
  for (let i = 0; i < iterations; i++) {
    const sc = { name: scenario.key, concurrency, attempt: `a${i}`, ...scenario.build() };
    runs.push(await runComposedEntry({ scenario: sc, seed: SEED_BASE + i }));
  }
  const completionVals = runs.map((r) => r.four_leg_completion_ms).filter((v) => Number.isFinite(v));
  return {
    scenario: scenario.key,
    concurrency,
    iterations,
    four_leg_completions: runs.filter((r) => r.four_leg_completed).length,
    detection_to_first_send_ms: summarise(runs, "detection_to_first_send_ms"),
    first_to_last_send_ms: summarise(runs, "first_to_last_send_ms"),
    first_fill_ms: summarise(runs, "first_fill_ms"),
    four_leg_completion_ms: summarise(runs, "four_leg_completion_ms"),
    cancel_to_terminal_ms: summarise(runs, "cancel_to_terminal_ms"),
    fill_dispersion_ms: summarise(runs, "fill_dispersion_ms"),
    persistence_wait_ms: summarise(runs, "persistence_wait_ms"),
    pacing_wait_ms: summarise(runs, "pacing_wait_ms"),
    rate_limit_cooldown_ms: summarise(runs, "rate_limit_cooldown_ms"),
    rest_polls: summarise(runs, "rest_polls"),
    adapter_ext_observations: summarise(runs, "adapter_ext_observations"),
    outcomes: {
      completed: runs.reduce((a, r) => a + r.completed, 0),
      partial: runs.reduce((a, r) => a + r.partial, 0),
      cancelled: runs.reduce((a, r) => a + r.cancelled, 0),
      rejected: runs.reduce((a, r) => a + r.rejected, 0),
    },
    completion_histogram: histogram(completionVals),
  };
}

function fmt(s) {
  if (!s) return "  n/a";
  const v = (x) => (x === null ? "  -" : String(x).padStart(5));
  return `${v(s.p50)}/${v(s.p95)}/${v(s.max)}`;
}

async function main() {
  const json = process.argv.includes("--json");
  const itArg = process.argv.find((a) => a.startsWith("--iterations="));
  const iterations = itArg ? Math.max(1, parseInt(itArg.split("=")[1], 10)) : 300;

  const report = {
    kind: "offline-composed-path",
    generated_at_note: "offline; no broker, no network, no database — pure code + assumed delays",
    iterations,
    assumptions: REPORTED_ASSUMPTIONS,
    cells: [],
  };

  for (const scenario of SCENARIOS) {
    for (const concurrency of CONCURRENCIES) {
      report.cells.push(await runCell(scenario, concurrency, iterations));
    }
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("═══════════════════════════════════════════════════════════════════════════════════");
  console.log("OFFLINE COMPOSED-PATH EXECUTION BENCHMARK  (SIMULATED — NOT a live measurement)");
  console.log("Real classes: BoxOrderManager · KiteBrokerAdapter · OrderStreamConsumer · durable persistence");
  console.log("Time base: discrete-event scheduler (concurrent waits overlap). Broker: zerodha profile.");
  console.log(`Iterations per cell: ${iterations}   ·   identical seeds across concurrencies`);
  console.log("═══════════════════════════════════════════════════════════════════════════════════\n");

  console.log("ASSUMED broker/environment delays (INPUTS WE CHOSE — NOT measurements):");
  for (const [k, v] of Object.entries(REPORTED_ASSUMPTIONS)) {
    if (k.startsWith("_")) continue;
    console.log(`  ${k.padEnd(24)} ${JSON.stringify(v)}`);
  }
  console.log("");

  for (const scenario of SCENARIOS) {
    console.log(`── ${scenario.key} ──  ${scenario.title}`);
    console.log("  conc | det→1st send | 1st→last send | first fill  | 4-leg complete | rest/extobs | 4/4 legs | n");
    console.log("       | p50/p95/max  | p50/p95/max   | p50/p95/max | p50/p95/max    | polls/appld |  count   |");
    for (const concurrency of CONCURRENCIES) {
      const c = report.cells.find((x) => x.scenario === scenario.key && x.concurrency === concurrency);
      const rp = c.rest_polls.p50, se = c.adapter_ext_observations.p50;
      console.log(
        `   ${concurrency}   |${fmt(c.detection_to_first_send_ms)}|${fmt(c.first_to_last_send_ms)}|` +
        `${fmt(c.first_fill_ms)}|${fmt(c.four_leg_completion_ms)}|  ${String(rp).padStart(3)}/${String(se).padStart(3)}  |` +
        ` ${String(c.four_leg_completions).padStart(4)}/${c.iterations} | ${c.iterations}`,
      );
    }
    // Distribution for concurrency 2 as a representative histogram of four-leg completion.
    const rep = report.cells.find((x) => x.scenario === scenario.key && x.concurrency === 2);
    const h = rep.completion_histogram;
    const total = h.buckets.reduce((a, b) => a + b, 0) || 1;
    const bars = h.labels.map((lbl, i) => `${lbl}ms:${h.buckets[i]}`).join("  ");
    console.log(`   four-leg completion histogram (conc 2, n=${total}): ${bars}`);
    // Honest outcome accounting: every leg outcome is visible, none hidden.
    const o = rep.outcomes;
    console.log(`   leg outcomes (conc 2): completed=${o.completed} partial=${o.partial} cancelled=${o.cancelled} rejected=${o.rejected}`);
    console.log("");
  }

  console.log("WHAT THIS BENCHMARK CAN TELL YOU:");
  console.log("  • The COST OF OUR OWN CODE on the composed path: durable-intent write ordering, the");
  console.log("    adapter's pacing arithmetic, the waitForResolution loop, the REST-poll cadence, the");
  console.log("    order-stream projection/wake, and BoxOrderManager queueing/concurrency — all real code.");
  console.log("  • How raising entry concurrency overlaps legs WITHIN a hedge-first wave (and why it does");
  console.log("    NOT collapse four-leg execution to one round trip: dependent SELLs still wait for the");
  console.log("    two BUY hedges to be CONFIRMED).");
  console.log("  • That a healthy order stream makes the SAME confirmed fill arrive sooner while the REST");
  console.log("    poll remains a working fallback. `rest polls` is NEVER zero — the real waitForResolution");
  console.log("    loop always confirms via getOrder — and `extobs` counts external observations APPLIED to");
  console.log("    the adapter (push events PLUS manager-forwarded REST snapshots), so it can be >0 even when");
  console.log("    the push stream is off. Neither ever removes the REST confirmation.");
  console.log("");
  console.log("WHAT THIS BENCHMARK CANNOT TELL YOU (and must never be quoted as):");
  console.log("  • Live Mumbai broker latency. Every broker delay above is an ASSUMPTION we chose.");
  console.log("  • Any fill rate or four-leg completion rate as a GUARANTEE. The completion counts above");
  console.log("    are a property of the assumed reject/cancel/partial rates, not a promise.");
  console.log("  • Exchange queue position, matching-engine behaviour, TLS/network path, or broker-side");
  console.log("    load — none are modelled and none can be, offline.");
  console.log("");
  console.log("SUPERVISED LIVE EVIDENCE STILL NEEDED before anyone may assert latency or fill-rate:");
  console.log("  1. Timed, supervised paper/live sessions from the Mumbai EC2 host with the REAL brokers,");
  console.log("     recording detection→send→ack→fill from the adapter's own timing instrumentation.");
  console.log("  2. Observed REST-poll vs stream-event confirmation timing against the real order stream.");
  console.log("  3. Real 429/Retry-After behaviour and real partial-fill/cancel distributions per broker.");
  console.log("  4. A separate real-timed run of the Dhan adapter (its pacer uses wall time): see");
  console.log("     bench/compositeRealTimed.mjs.");
}

main().catch((err) => { console.error(err); process.exit(1); });
