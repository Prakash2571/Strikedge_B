/**
 * STATIC HERMETIC GUARD for the unit suite (tests/box/*.test.mjs).
 *
 * WHY THIS EXISTS
 * `npm run test:unit` is `node --test "tests/box/*.test.mjs"` and is DOCUMENTED and
 * INTENDED as the database-free, network-free unit suite. It regressed once already:
 * `executionAttemptProjection.test.mjs` imported the `pg` driver and opened a real
 * connection to PostgreSQL on port 55432, so the "unit" suite silently depended on a
 * database. That real-PostgreSQL test now lives in tests/pg/ where it belongs.
 *
 * This guard makes that regression IMPOSSIBLE to reintroduce silently. It is a STATIC
 * source scan (it reads the source of every sibling unit test, it does not execute
 * them), so it is robust regardless of whether a hypothetical offending test would even
 * run its DB code under the current environment.
 *
 * THE CONTRACT — a file in tests/box/ FAILS this guard if it:
 *   1. imports (static `import … from` OR dynamic `import(…)` OR `require(…)`) the `pg`
 *      or `mongodb` driver — the only two real database clients in this repo; or
 *   2. embeds a database port (PostgreSQL 55432, MongoDB 57017) — the tell-tale of a
 *      hard-coded real connection string; or
 *   3. embeds a connection URL to a non-loopback host (a `postgres://` / `mongodb://`
 *      URL whose host is not 127.0.0.1 / localhost / ::1).
 *
 * The complementary RUNTIME interception (tests/box/hermeticNetwork.test.mjs +
 * tests/helpers/hermeticNetwork.mjs) fails closed on any live BROKER egress; this static
 * guard closes the DATABASE-driver hole. Keep BOTH.
 *
 * This guard scans EVERY tests/box/*.test.mjs (including itself); the tokens it forbids
 * are only ever mentioned here inside string literals / comments, never as imports or
 * connection strings, and the scanner is written to distinguish those (it matches import
 * specifiers and connection URLs, not arbitrary substrings), so it does not flag itself.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));

/** Every unit-suite test file, exactly the glob `node --test` runs. */
function unitTestFiles() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();
}

/**
 * Strip `//` line comments and `/* … *\/` block comments so the scanner matches CODE, not
 * documentation. This is what lets the guard scan ITSELF (whose doc comments necessarily
 * spell out the forbidden import forms) and lets any test mention a driver in prose without
 * tripping the driver-import check. It is deliberately conservative: it does not attempt to
 * respect comment-like sequences inside string literals, which is safe here because a real
 * `import`/`require`/connection-URL never hides behind such a construct in these test files.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The forbidden database drivers. These are the only real DB clients in package.json. */
const FORBIDDEN_DRIVERS = ["pg", "mongodb"];

/** Database ports that only ever appear inside a real connection string. */
const FORBIDDEN_DB_PORTS = ["55432", "57017"];

/**
 * Match a module specifier being IMPORTED, in any of the three forms Node supports:
 *   import … from "pg";        import "pg";        (static)
 *   import("pg")               await import('pg') (dynamic)
 *   require("pg")                                  (CJS, for completeness)
 * The specifier must be EXACTLY the driver or a subpath of it (`pg`, `pg/lib/...`,
 * `mongodb`, `mongodb/...`) — not a substring like `pgbouncer` or an assertion regex.
 */
function driverImportRegexes(driver) {
  const spec = `${driver}(?:/[^"'\\s]*)?`;
  return [
    // import ... from "pg" / import "pg"
    new RegExp(`\\bimport\\b[^;\\n]*?from\\s*["']${spec}["']`),
    new RegExp(`\\bimport\\s*["']${spec}["']`),
    // import("pg") / import( "pg" )
    new RegExp(`\\bimport\\s*\\(\\s*["']${spec}["']\\s*\\)`),
    // require("pg")
    new RegExp(`\\brequire\\s*\\(\\s*["']${spec}["']\\s*\\)`),
  ];
}

/** A connection URL to a non-loopback host, e.g. postgres://user:pw@db.example.com/… */
const NON_LOOPBACK_CONN_URL = /\b(?:postgres|postgresql|mongodb)(?:\+srv)?:\/\/[^\s"']*/g;

function connUrlHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "";
}

test("the unit suite contains at least the expected battery of test files", () => {
  // A floor, so an accidental empty glob or a mass deletion can never make the guard
  // (and the suite) vacuously pass.
  const files = unitTestFiles();
  assert.ok(
    files.length >= 80,
    `expected the unit suite to contain its full battery of test files, found only ${files.length}`,
  );
  assert.ok(files.includes(SELF), "the guard must scan itself");
});

test("no unit test imports the pg or mongodb database driver", () => {
  const offenders = [];
  for (const file of unitTestFiles()) {
    const src = stripComments(readFileSync(join(HERE, file), "utf8"));
    for (const driver of FORBIDDEN_DRIVERS) {
      for (const rx of driverImportRegexes(driver)) {
        const m = src.match(rx);
        if (m) offenders.push({ file, driver, snippet: m[0].trim() });
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    offenders.length === 0
      ? ""
      : `The unit suite (tests/box/*.test.mjs) must be database-free, but these files import a ` +
          `real database driver:\n` +
          offenders
            .map((o) => `  • ${o.file}: imports "${o.driver}"  ->  ${o.snippet}`)
            .join("\n") +
          `\n\nA test that needs a real PostgreSQL belongs in tests/pg/ (run by \`npm run test:pg\`), ` +
          `and one that needs a real MongoDB belongs in its own DB suite — NOT in the unit suite. ` +
          `Move it there. See tests/README.md > "Suite boundaries".`,
  );
});

test("no unit test embeds a database port (55432 PostgreSQL / 57017 MongoDB)", () => {
  const offenders = [];
  for (const file of unitTestFiles()) {
    if (file === SELF) continue; // this guard defines the port constants as code, by design
    // Strip comments so a test that merely NAMES a port in prose is not flagged, while a real
    // hard-coded connection string — a string literal, not a comment — is caught.
    const src = stripComments(readFileSync(join(HERE, file), "utf8"));
    for (const port of FORBIDDEN_DB_PORTS) {
      if (src.includes(port)) offenders.push({ file, port });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    offenders.length === 0
      ? ""
      : `The unit suite must never hard-code a database port, but found:\n` +
          offenders.map((o) => `  • ${o.file}: contains database port ${o.port}`).join("\n") +
          `\n\nThat is the signature of a real connection string. Move the test to tests/pg/ ` +
          `(PostgreSQL) or its DB suite (MongoDB). See tests/README.md.`,
  );
});

test("no unit test embeds a connection URL to a non-loopback host", () => {
  const offenders = [];
  for (const file of unitTestFiles()) {
    if (file === SELF) continue; // this guard documents an example non-loopback URL, by design
    const src = stripComments(readFileSync(join(HERE, file), "utf8"));
    const urls = src.match(NON_LOOPBACK_CONN_URL) ?? [];
    for (const url of urls) {
      const host = connUrlHost(url);
      // A bare scheme with no parseable host (e.g. the word "postgres://" in prose) is
      // not a connection string; only flag URLs that resolve to a real non-loopback host.
      if (host && !isLoopback(host)) offenders.push({ file, url, host });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    offenders.length === 0
      ? ""
      : `The unit suite must never point at a non-loopback database, but found:\n` +
          offenders
            .map((o) => `  • ${o.file}: connection URL to "${o.host}"  ->  ${o.url}`)
            .join("\n") +
          `\n\nUnit tests must not reach any database. Move the test to the appropriate DB suite. ` +
          `See tests/README.md.`,
  );
});
