#!/usr/bin/env bash
#
# Convenience runner for the offline composed-path execution benchmark (item 9).
#
# It builds (tests import from dist/) then runs the REAL composed-path benchmark. Every number it
# prints is a property of OUR code against ASSUMED broker delays — NOT a live measurement and NOT a
# guaranteed fill rate. See docs/LATENCY_BENCHMARK.md.
#
# Usage:
#   scripts/bench.sh                 human-readable report (default 300 iters/cell)
#   scripts/bench.sh --json          machine-readable
#   scripts/bench.sh --iterations=50 quicker
#   scripts/bench.sh --dhan          the REAL DhanBrokerAdapter wall-time smoke (non-comparable)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "building (dist/ is imported by the benchmark)…"
npm run --silent build

if [[ "${1:-}" == "--dhan" ]]; then
  shift || true
  exec node bench/compositeRealTimed.mjs "$@"
fi

exec node bench/composedLatency.mjs "$@"
