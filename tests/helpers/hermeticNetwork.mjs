/**
 * HERMETIC NETWORK — the fail-closed broker-egress guard for the test suite.
 *
 * WHY THIS EXISTS
 * Three suites reached live broker endpoints through the REAL code paths:
 *   - `DhanInstrumentStore.fetchMaster()` downloads the ~201k-row Dhan scrip master
 *     from images.dhan.co on every `switchBroker("dhan", …)` and every
 *     `InstrumentProvider.load()` while Dhan is active.
 *   - `KiteClient.getInstruments()` downloads the Zerodha instrument dump from
 *     api.kite.trade whenever `InstrumentProvider.load()` runs while Zerodha is active
 *     (e.g. a morning switch back to Zerodha).
 * Both go through `globalThis.fetch`, so intercepting `fetch` is a production-faithful
 * seam that needs NO change to src/: the code under test runs unmodified; only the
 * socket at the very edge is replaced by a checked-in fixture.
 *
 * THE CONTRACT
 *   1. The Dhan scrip master (detailed AND fallback URL) is served from the trimmed,
 *      checked-in fixture — deterministic and tiny.
 *   2. The Zerodha instrument dump (api.kite.trade/instruments…) is served from a
 *      minimal CSV stub with the exact Kite header, so getInstruments() succeeds.
 *   3. Any additional broker endpoint a test needs is registered explicitly via
 *      `stub(...)`.
 *   4. FAIL CLOSED. A request to any host that is neither loopback nor explicitly
 *      stubbed THROWS, naming the URL. An unstubbed dial-out breaks the test rather
 *      than silently reaching the internet. This is the property that keeps the suite
 *      hermetic forever, not just today.
 *
 * Loopback (127.0.0.1 / localhost / ::1) is always allowed — PostgreSQL and MongoDB
 * live there and are legitimate test infrastructure.
 *
 * Always `restore()` in an `after()` hook so the patched fetch cannot leak into the
 * next file loaded by the same process.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The trimmed Dhan scrip master. Provenance is documented in tests/fixtures/README.md. */
const DHAN_SCRIP_MASTER_FIXTURE = join(HERE, "..", "fixtures", "dhan-scrip-master-detailed.sample.csv");

/**
 * Minimal Zerodha instruments CSV — the exact Kite header followed by a couple of
 * rows so `parseInstrumentsCsv` yields a non-empty universe. api.kite.trade/instruments
 * is a public CSV dump; this stub stands in for it. The numbers are Kite-namespace
 * tokens and unrelated to the Dhan fixture's tokens by design.
 */
const KITE_INSTRUMENTS_CSV = [
  "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
  "256265,1001,NIFTY 50,NIFTY,0,,0,0.05,0,EQ,INDICES,INDICES",
  "12345678,48225,NIFTY26OCTFUT,NIFTY,0,2026-10-27,0,0.05,65,FUT,NFO-FUT,NFO",
  "12345679,48226,NIFTY26NOVFUT,NIFTY,0,2026-11-23,0,0.05,65,FUT,NFO-FUT,NFO",
  "738561,2885,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.05,0,EQ,NSE,NSE",
  "",
].join("\n");

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function textResponse(body, contentType = "text/csv") {
  // A real global Response — the code under test calls res.ok / res.text().
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

/**
 * Arm the hermetic guard. Returns a handle:
 *   - `stub(matcher, responder)` registers an extra endpoint. `matcher` is a string
 *     (substring or exact host match) or a `(url) => boolean` predicate; `responder`
 *     is `(url, init) => Response | Promise<Response>`.
 *   - `calls` is the list of every URL fetch saw, for assertions.
 *   - `restore()` puts the original fetch back. ALWAYS call it in `after()`.
 */
export function installHermeticNetwork(options = {}) {
  const original = globalThis.fetch;
  const calls = [];
  const extraStubs = [];

  const dhanMasterCsv = options.dhanMasterCsv ?? readFileSync(DHAN_SCRIP_MASTER_FIXTURE, "utf8");
  const kiteInstrumentsCsv = options.kiteInstrumentsCsv ?? KITE_INSTRUMENTS_CSV;

  function stub(matcher, responder) {
    const test =
      typeof matcher === "function"
        ? matcher
        : (url) => {
            const host = hostname(url);
            return url.includes(matcher) || host === matcher;
          };
    extraStubs.push({ test, responder });
  }

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    calls.push(url);
    const host = hostname(url);

    // Loopback is real test infrastructure (PostgreSQL, MongoDB) — pass through.
    if (host && isLoopback(host)) {
      return original(input, init);
    }

    // Explicit per-test stubs take precedence over the built-ins.
    for (const { test, responder } of extraStubs) {
      if (test(url)) return responder(url, init);
    }

    // The Dhan scrip master (detailed + fallback layout).
    if (host === "images.dhan.co" && url.includes("api-scrip-master")) {
      return textResponse(dhanMasterCsv);
    }

    // The Zerodha instrument dump.
    if (host === "api.kite.trade" && url.includes("/instruments")) {
      return textResponse(kiteInstrumentsCsv);
    }

    // FAIL CLOSED: anything else that is not loopback is a real dial-out. Break the
    // test loudly and name the URL so the offending call site is obvious.
    throw new Error(
      `HERMETIC NETWORK VIOLATION: unstubbed outbound request to "${url}" ` +
        `(host: ${host ?? "unknown"}). Tests must never contact a real broker. ` +
        `Add a fixture/stub in tests/helpers/hermeticNetwork.mjs or via the returned ` +
        `stub() handle. See tests/README.md > "Hermetic network".`,
    );
  };

  return {
    calls,
    stub,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** The list of non-loopback hosts the guard saw — for regression assertions. */
export function nonLoopbackHosts(calls) {
  const hosts = new Set();
  for (const url of calls) {
    const host = hostname(url);
    if (host && !isLoopback(host)) hosts.add(host);
  }
  return [...hosts];
}
