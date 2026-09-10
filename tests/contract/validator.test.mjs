/**
 * UNIT TESTS FOR THE CONTRACT VALIDATOR ITSELF.
 *
 * The validator is the load-bearing part of the whole gate: if it silently ignores
 * a keyword, every schema that uses that keyword is unenforced while looking
 * enforced. So these tests pin BOTH that each supported keyword actually bites AND
 * that an unsupported keyword is a LOUD ERROR rather than a silent pass.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validate, SchemaError } from "../../contract/validate.mjs";

const ok = (v, s, opts) => assert.deepEqual(validate(v, s, opts), [], "expected no errors");
const bad = (v, s, opts) => {
  const errs = validate(v, s, opts);
  assert.ok(errs.length > 0, "expected at least one error");
  return errs;
};

/* ─────────────────────────────── type ─────────────────────────────── */

test("type: primitives and integer-vs-number distinction", () => {
  ok(1, { type: "integer" });
  ok(1.5, { type: "number" });
  bad(1.5, { type: "integer" });
  ok("x", { type: "string" });
  ok(true, { type: "boolean" });
  ok(null, { type: "null" });
  ok([], { type: "array" });
  ok({}, { type: "object" });
  // integer also satisfies number
  ok(3, { type: "number" });
});

test("type: a union array is how nullable is modelled", () => {
  ok(null, { type: ["string", "null"] });
  ok("x", { type: ["string", "null"] });
  bad(1, { type: ["string", "null"] });
});

test("type: mismatch names the actual type in the error", () => {
  const [e] = bad(1, { type: "string" });
  assert.match(e.message, /expected type string but got integer/);
  assert.equal(e.path, "#");
});

/* ───────────────────────── required / properties ───────────────────── */

test("required: a missing property is reported by name", () => {
  const [e] = bad({ a: 1 }, { type: "object", required: ["a", "b"], properties: {} });
  assert.equal(e.path, "b");
  assert.match(e.message, /required property is missing/);
});

test("properties: subschemas apply at nested paths", () => {
  const s = { type: "object", properties: { a: { type: "object", properties: { b: { type: "integer" } } } } };
  const [e] = bad({ a: { b: "no" } }, s);
  assert.equal(e.path, "a.b");
});

/* ───────────────────────── additionalProperties ────────────────────── */

test("additionalProperties:false catches an ADDED field by name", () => {
  const s = { type: "object", additionalProperties: false, properties: { a: { type: "integer" } } };
  ok({ a: 1 }, s);
  const [e] = bad({ a: 1, sneaky: 2 }, s);
  assert.equal(e.path, "sneaky");
  assert.match(e.message, /additional property is not allowed/);
});

test("additionalProperties as a schema validates the extra values", () => {
  const s = { type: "object", properties: {}, additionalProperties: { type: "integer" } };
  ok({ x: 1, y: 2 }, s);
  bad({ x: "no" }, s);
});

/* ─────────────────────────── items / prefixItems ───────────────────── */

test("items: every element must satisfy the subschema", () => {
  ok([1, 2, 3], { type: "array", items: { type: "integer" } });
  const [e] = bad([1, "no"], { type: "array", items: { type: "integer" } });
  assert.equal(e.path, "1");
});

test("prefixItems: positional element schemas, then items for the rest", () => {
  const s = { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: { type: "boolean" } };
  ok(["a", 1, true, false], s);
  bad(["a", "no"], s); // second element must be integer
  bad(["a", 1, "no"], s); // third onward must be boolean
});

/* ───────────────────────────── enum / const ────────────────────────── */

test("enum and const", () => {
  ok("b", { enum: ["a", "b"] });
  bad("z", { enum: ["a", "b"] });
  ok(true, { const: true });
  bad(false, { const: true });
  // deep const
  ok({ a: [1, 2] }, { const: { a: [1, 2] } });
  bad({ a: [1, 3] }, { const: { a: [1, 2] } });
});

/* ───────────────────────────── oneOf / anyOf ───────────────────────── */

test("oneOf must match exactly one branch", () => {
  const s = { oneOf: [{ type: "string" }, { type: "integer" }] };
  ok("x", s);
  ok(3, s);
  bad(true, s); // matches neither
  // matches both -> fails
  const two = { oneOf: [{ type: "integer" }, { type: "number" }] };
  bad(3, two);
});

test("anyOf must match at least one branch", () => {
  const s = { anyOf: [{ type: "string" }, { type: "integer" }] };
  ok("x", s);
  ok(3, s);
  bad(true, s);
  // matches both -> still fine for anyOf
  ok(3, { anyOf: [{ type: "integer" }, { type: "number" }] });
});

/* ─────────────────────────────── $ref ──────────────────────────────── */

test("$ref resolves against the sibling registry", () => {
  const registry = { "leg.schema.json": { type: "object", required: ["role"], properties: { role: { type: "string" } } } };
  const s = { type: "array", items: { $ref: "leg.schema.json" } };
  ok([{ role: "k1" }], s, { registry });
  const [e] = bad([{}], s, { registry });
  assert.equal(e.path, "0.role");
});

test("$ref to an unknown sibling is a LOUD SchemaError", () => {
  assert.throws(() => validate({}, { $ref: "nope.schema.json" }, { registry: {} }), SchemaError);
});

test("$ref combined with siblings is a LOUD SchemaError (no silent merge)", () => {
  const registry = { "x.schema.json": { type: "object" } };
  assert.throws(
    () => validate({}, { $ref: "x.schema.json", type: "object" }, { registry }),
    /must not be combined/,
  );
});

/* ─────────────────────────── minimum / maximum ─────────────────────── */

test("minimum and maximum are inclusive", () => {
  ok(5, { type: "integer", minimum: 5, maximum: 5 });
  bad(4, { type: "integer", minimum: 5 });
  bad(6, { type: "integer", maximum: 5 });
});

/* ───────────────────────── minItems (SECTION 7) ───────────────────────── */

/**
 * `minItems` is ENFORCED, not annotated.
 *
 * It was added for `operational-readiness.exposure_management.limitations`, which must never be
 * empty: an empty limitations list would read as "reducing exposure carries no caveats", which is
 * the precise false reassurance that field exists to prevent. A keyword that validated nothing
 * would let exactly that through, so it is implemented and pinned here.
 */
test("minItems enforces an array length floor", () => {
  ok(["a"], { type: "array", minItems: 1, items: { type: "string" } });
  ok(["a", "b"], { type: "array", minItems: 1, items: { type: "string" } });
  bad([], { type: "array", minItems: 1, items: { type: "string" } });
  bad(["a"], { type: "array", minItems: 2, items: { type: "string" } });
});

test("minItems reports the actual length, and still validates the elements", () => {
  const errs = validate([], { type: "array", minItems: 2, items: { type: "string" } });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /at least 2 item\(s\), got 0/);
  // A long-enough array with a bad element still reports the element error.
  const elementErrs = validate(["a", 7], { type: "array", minItems: 1, items: { type: "string" } });
  assert.equal(elementErrs.length, 1);
  assert.equal(elementErrs[0].path, "1");
});

test("minItems works with no items keyword, and a non-integer minItems is a LOUD error", () => {
  ok([1, 2], { type: "array", minItems: 2 });
  bad([1], { type: "array", minItems: 2 });
  assert.throws(() => validate([1], { type: "array", minItems: 1.5 }), /minItems .* non-negative integer/);
  assert.throws(() => validate([1], { type: "array", minItems: -1 }), /minItems .* non-negative integer/);
});

/* ───────────────────────── format: date-time ───────────────────────── */

test("format date-time is a shallow ISO-8601 check", () => {
  ok("2026-09-09T03:14:02.000Z", { type: "string", format: "date-time" });
  ok("2026-09-09T03:14:02+05:30", { type: "string", format: "date-time" });
  bad("not-a-date", { type: "string", format: "date-time" });
});

/* ══════════════════ THE LOUD-ERROR CONTRACT (the point) ══════════════ */

test("an UNSUPPORTED keyword is a LOUD ERROR, never silently ignored", () => {
  // If this ever starts PASSING silently, the whole gate is compromised: a schema
  // could declare a constraint the validator does not enforce and nobody would know.
  assert.throws(() => validate({}, { type: "object", patternProperties: {} }), SchemaError);
  assert.throws(() => validate("x", { type: "string", minLength: 3 }), /unsupported schema keyword "minLength"/);
  assert.throws(() => validate([], { type: "array", uniqueItems: true }), /unsupported schema keyword "uniqueItems"/);
  assert.throws(() => validate({}, { not: { type: "string" } }), /unsupported schema keyword "not"/);
});

test("an unsupported format value is a LOUD ERROR", () => {
  assert.throws(() => validate("x@y.com", { type: "string", format: "email" }), SchemaError);
  assert.throws(() => validate("x", { type: "string", format: "uuid" }), /format "uuid".*not supported/);
});

test("annotation keywords are accepted and impose no obligation", () => {
  const s = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "x.schema.json",
    title: "t",
    description: "d",
    $comment: "c",
    examples: [1],
    default: 0,
    type: "integer",
  };
  ok(3, s);
  bad("no", s);
});

test("nested unsupported keywords are caught too (not just at the root)", () => {
  const s = { type: "object", properties: { a: { type: "string", contains: {} } } };
  assert.throws(() => validate({ a: "x" }, s), /unsupported schema keyword "contains"/);
});
