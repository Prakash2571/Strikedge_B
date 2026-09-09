/**
 * Compute a STABLE sha256 digest over the versioned contract files:
 *   - contract/schemas/**.schema.json   (the JSON-Schema wire shapes), and
 *   - contract/protocol.json            (machine-readable protocol constants such
 *                                        as the CSRF header name — see that file).
 *
 * DETERMINISM CONTRACT (the frontend pins this exact value):
 *   1. Included files are: every *.schema.json under contract/schemas/, PLUS the
 *      single sibling contract/protocol.json.
 *   2. Files are hashed in a deterministic order: the schema files sorted by
 *      filename (byte-wise, via default string sort), then protocol.json last.
 *      protocol.json is hashed under the stable logical name "protocol.json" so
 *      its position in the digest never depends on where it lives on disk.
 *   3. For each file we hash: its (logical) filename, a NUL separator, its EXACT
 *      bytes as stored on disk, and a NUL separator. No normalisation, no
 *      re-serialisation — the bytes on disk are the contract, so a whitespace-only
 *      edit still changes the digest (and must therefore bump version.json). This
 *      is intentional: the digest exists to make an UNCOORDINATED contract change
 *      impossible to miss, whether it is a schema shape OR a protocol constant like
 *      the CSRF header name.
 *
 * USAGE:
 *   node contract/digest.mjs            -> prints the hex digest to stdout
 *   import { computeSchemasDigest }     -> returns { digest, files }
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMAS_DIR = resolve(HERE, "schemas");
/** The sibling protocol-constants file, hashed alongside the schemas. */
export const PROTOCOL_FILE = resolve(HERE, "protocol.json");
/** The stable logical name protocol.json is hashed under (never its disk path). */
const PROTOCOL_LOGICAL_NAME = "protocol.json";

/** List the schema files (basenames) in deterministic order. */
export function listSchemaFiles(dir = SCHEMAS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
}

/**
 * Compute the digest over every schema file PLUS protocol.json. Returns the hex
 * digest and the list of files (in the exact order they were hashed) for reporting.
 * protocol.json appears last in the returned list under its logical name.
 */
export function computeSchemasDigest(dir = SCHEMAS_DIR, protocolFile = PROTOCOL_FILE) {
  const schemaFiles = listSchemaFiles(dir);
  const hash = createHash("sha256");
  for (const name of schemaFiles) {
    const bytes = readFileSync(resolve(dir, name));
    hash.update(name, "utf8");
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    hash.update(Buffer.from([0]));
  }
  // protocol.json is hashed LAST, under a stable logical name, so a change to it
  // (e.g. renaming the CSRF header) changes schemas_sha256 exactly as a schema edit would.
  const protocolBytes = readFileSync(protocolFile);
  hash.update(PROTOCOL_LOGICAL_NAME, "utf8");
  hash.update(Buffer.from([0]));
  hash.update(protocolBytes);
  hash.update(Buffer.from([0]));

  return { digest: hash.digest("hex"), files: [...schemaFiles, PROTOCOL_LOGICAL_NAME] };
}

// When run directly, print the digest so it can be copied into version.json.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { digest, files } = computeSchemasDigest();
  process.stdout.write(`${digest}\n`);
  if (process.argv.includes("--verbose")) {
    process.stderr.write(`hashed ${files.length} contract file(s):\n`);
    for (const f of files) process.stderr.write(`  ${f}\n`);
  }
}
