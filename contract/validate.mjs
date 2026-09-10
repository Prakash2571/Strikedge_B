/**
 * A DEPENDENCY-FREE JSON Schema (draft 2020-12 SUBSET) validator.
 *
 * WHY THIS EXISTS
 * The backend deliberately ships only express, pg, mongodb and dotenv (see
 * package.json). Pulling ajv (or any validator) in would break that contract and
 * add a supply-chain surface for what is, in the end, a small, closed problem: we
 * validate a handful of response shapes the frontend depends on.
 *
 * SCOPE — SUPPORTED KEYWORDS (and NOTHING else):
 *   type              object | array | string | number | integer | boolean | null,
 *                     and a UNION of those as an array (this is how we model nullable).
 *   required          array of property names that MUST be present.
 *   properties        per-property subschemas.
 *   additionalProperties
 *                     boolean OR a subschema. false => a property not named in
 *                     `properties` is an error (this is how an ADDED field is caught).
 *   items             subschema every array element must satisfy.
 *   prefixItems       array of subschemas positionally applied to the first N elements.
 *   enum              value must be deep-equal to one of the listed values.
 *   const             value must be deep-equal to the given value.
 *   oneOf             value must match EXACTLY ONE listed subschema.
 *   anyOf             value must match AT LEAST ONE listed subschema.
 *   $ref              "<name>.schema.json" — a reference to a SIBLING schema by file
 *                     name, resolved from the registry passed to validate().
 *   minimum / maximum inclusive numeric bounds.
 *   format            only "date-time" is understood, and only SHALLOWLY (a syntactic
 *                     ISO-8601 check); any other format value is a LOUD ERROR.
 *
 * ANNOTATION KEYWORDS that carry no validation obligation are explicitly ignored:
 *   $schema, $id, title, description, $comment, examples, default, deprecated,
 *   readOnly, writeOnly.
 *
 * ANYTHING ELSE IS A LOUD ERROR.
 * A validator that silently skips a keyword it does not understand is worse than
 * no validator: the author believes a constraint is enforced when it is not. So an
 * unknown keyword — or `format` with an unsupported value — throws a
 * SchemaError at validation time. This is unit-tested.
 *
 * OUTPUT: validate() returns a LIST of { path, message } errors (empty === valid).
 * `path` is a JSON-Pointer-ish dotted path naming exactly where the failure is, so
 * a deleted or renamed field is reported by name.
 */

/** Thrown when the SCHEMA itself uses something this validator does not support. */
export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaError";
  }
}

/** Keywords that impose a validation obligation this validator understands. */
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "$ref",
  "minimum",
  "maximum",
  // SECTION 7: a genuinely enforced array-length floor. Added because
  // operational-readiness.exposure_management.limitations must NEVER be empty — an empty
  // limitations list would read as "reduction has no caveats", which is the exact false
  // reassurance the field exists to prevent. Implemented, not ignored (see below).
  "minItems",
  "format",
]);

/** Annotation-only keywords that carry no validation obligation. */
const IGNORED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "$comment",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Deep structural equality for enum/const comparison (JSON values only). */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** The JSON type of a runtime value, using the JSON Schema type names. */
function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value) ? "integer" : "number";
  if (t === "boolean") return "boolean";
  if (t === "string") return "string";
  if (t === "object") return "object";
  // undefined / function / symbol / bigint are not JSON values.
  throw new SchemaError(`value at runtime is not a JSON value: typeof === ${t}`);
}

/** True when `value` satisfies a single declared JSON-Schema type name. */
function matchesType(value, typeName) {
  const actual = jsonTypeOf(value);
  if (typeName === "number") return actual === "number" || actual === "integer";
  return actual === typeName;
}

/** Shallow ISO-8601 date-time syntactic check (does not verify calendar validity). */
const DATE_TIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Assert a schema node only uses keywords this validator understands. */
function assertKnownKeywords(schema, path) {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new SchemaError(`schema at ${path || "#"} must be an object`);
  }
  for (const key of Object.keys(schema)) {
    if (SUPPORTED_KEYWORDS.has(key) || IGNORED_KEYWORDS.has(key)) continue;
    throw new SchemaError(
      `unsupported schema keyword "${key}" at ${path || "#"} — this validator refuses to ` +
        `silently ignore it. Extend contract/validate.mjs (and its tests) or remove the keyword.`,
    );
  }
}

/**
 * Validate `value` against `schema`.
 *
 * @param {unknown} value        The (already JSON-parsed) value to check.
 * @param {object}  schema       The schema node.
 * @param {object}  [opts]
 * @param {Record<string,object>} [opts.registry]  name -> schema, for $ref resolution.
 * @returns {{path:string,message:string}[]}  Empty when valid.
 */
export function validate(value, schema, opts = {}) {
  const registry = opts.registry ?? {};
  const errors = [];
  validateNode(value, schema, "", registry, errors);
  return errors;
}

function validateNode(value, schema, path, registry, errors) {
  assertKnownKeywords(schema, path);

  // $ref replaces the schema at this position with the referenced sibling schema.
  if (Object.prototype.hasOwnProperty.call(schema, "$ref")) {
    const ref = schema.$ref;
    if (typeof ref !== "string" || !ref.endsWith(".schema.json")) {
      throw new SchemaError(
        `$ref at ${path || "#"} must be a sibling file name like "x.schema.json", got ${JSON.stringify(ref)}`,
      );
    }
    const target = registry[ref];
    if (!target) {
      throw new SchemaError(`$ref at ${path || "#"} points at unknown sibling schema "${ref}"`);
    }
    // A node using $ref must use ONLY $ref (plus annotations) — we do not implement
    // $ref-with-siblings merging, so refuse it loudly rather than silently ignore.
    for (const key of Object.keys(schema)) {
      if (key === "$ref" || IGNORED_KEYWORDS.has(key)) continue;
      throw new SchemaError(
        `$ref at ${path || "#"} must not be combined with "${key}" — this validator does not merge $ref with siblings.`,
      );
    }
    validateNode(value, target, path, registry, errors);
    return;
  }

  // enum / const are value-set constraints checked independently of type.
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    if (!deepEqual(value, schema.const)) {
      errors.push({ path: path || "#", message: `must equal const ${JSON.stringify(schema.const)}` });
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "enum")) {
    if (!Array.isArray(schema.enum)) throw new SchemaError(`enum at ${path || "#"} must be an array`);
    if (!schema.enum.some((allowed) => deepEqual(value, allowed))) {
      errors.push({
        path: path || "#",
        message: `must be one of enum ${JSON.stringify(schema.enum)}`,
      });
    }
  }

  // oneOf / anyOf — combinator branches. Each branch is validated in isolation.
  if (Object.prototype.hasOwnProperty.call(schema, "oneOf")) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new SchemaError(`oneOf at ${path || "#"} must be a non-empty array`);
    }
    const matches = schema.oneOf.filter((sub) => validateSubtree(value, sub, path, registry).length === 0);
    if (matches.length !== 1) {
      errors.push({
        path: path || "#",
        message: `must match exactly one oneOf branch (matched ${matches.length})`,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "anyOf")) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new SchemaError(`anyOf at ${path || "#"} must be a non-empty array`);
    }
    const anyMatch = schema.anyOf.some((sub) => validateSubtree(value, sub, path, registry).length === 0);
    if (!anyMatch) {
      errors.push({ path: path || "#", message: `must match at least one anyOf branch` });
    }
  }

  // type — single name or a union array. Union is how nullable is modelled.
  if (Object.prototype.hasOwnProperty.call(schema, "type")) {
    const declared = schema.type;
    const list = Array.isArray(declared) ? declared : [declared];
    for (const t of list) {
      if (typeof t !== "string" || !JSON_TYPES.has(t)) {
        throw new SchemaError(`type at ${path || "#"} has unsupported entry ${JSON.stringify(t)}`);
      }
    }
    const ok = list.some((t) => matchesType(value, t));
    if (!ok) {
      errors.push({
        path: path || "#",
        message: `expected type ${list.join("|")} but got ${jsonTypeOf(value)}`,
      });
      // Type mismatch: deeper checks would be noise. Stop here for this node.
      return;
    }
  }

  // format — only "date-time", only shallow. Anything else is a schema error.
  if (Object.prototype.hasOwnProperty.call(schema, "format")) {
    if (schema.format !== "date-time") {
      throw new SchemaError(
        `format "${schema.format}" at ${path || "#"} is not supported — only "date-time" is.`,
      );
    }
    if (typeof value === "string" && !DATE_TIME_RE.test(value)) {
      errors.push({ path: path || "#", message: `must be an ISO-8601 date-time string` });
    }
  }

  // minimum / maximum — inclusive numeric bounds.
  if (typeof value === "number") {
    if (Object.prototype.hasOwnProperty.call(schema, "minimum")) {
      if (typeof schema.minimum !== "number") throw new SchemaError(`minimum at ${path || "#"} must be a number`);
      if (value < schema.minimum) {
        errors.push({ path: path || "#", message: `must be >= ${schema.minimum}` });
      }
    }
    if (Object.prototype.hasOwnProperty.call(schema, "maximum")) {
      if (typeof schema.maximum !== "number") throw new SchemaError(`maximum at ${path || "#"} must be a number`);
      if (value > schema.maximum) {
        errors.push({ path: path || "#", message: `must be <= ${schema.maximum}` });
      }
    }
  }

  // Object shape: properties, required, additionalProperties.
  const hasObjectKeywords =
    Object.prototype.hasOwnProperty.call(schema, "properties") ||
    Object.prototype.hasOwnProperty.call(schema, "required") ||
    Object.prototype.hasOwnProperty.call(schema, "additionalProperties");
  if (hasObjectKeywords && jsonTypeOf(value) === "object") {
    const props = schema.properties ?? {};
    if (typeof props !== "object" || props === null || Array.isArray(props)) {
      throw new SchemaError(`properties at ${path || "#"} must be an object`);
    }

    if (Object.prototype.hasOwnProperty.call(schema, "required")) {
      if (!Array.isArray(schema.required)) throw new SchemaError(`required at ${path || "#"} must be an array`);
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          errors.push({ path: joinPath(path, name), message: `required property is missing` });
        }
      }
    }

    for (const [name, subschema] of Object.entries(props)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        validateNode(value[name], subschema, joinPath(path, name), registry, errors);
      }
    }

    if (Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
      const ap = schema.additionalProperties;
      const declared = new Set(Object.keys(props));
      for (const name of Object.keys(value)) {
        if (declared.has(name)) continue;
        if (ap === false) {
          errors.push({ path: joinPath(path, name), message: `additional property is not allowed` });
        } else if (ap === true) {
          // explicitly allowed, no further check
        } else if (typeof ap === "object" && ap !== null) {
          validateNode(value[name], ap, joinPath(path, name), registry, errors);
        } else {
          throw new SchemaError(`additionalProperties at ${path || "#"} must be a boolean or a schema`);
        }
      }
    }
  }

  // Array shape: prefixItems then items.
  const hasArrayKeywords =
    Object.prototype.hasOwnProperty.call(schema, "items") ||
    Object.prototype.hasOwnProperty.call(schema, "prefixItems") ||
    Object.prototype.hasOwnProperty.call(schema, "minItems");
  if (hasArrayKeywords && jsonTypeOf(value) === "array") {
    // minItems — an ENFORCED length floor, checked before the element walk so a too-short array
    // reports its real problem rather than merely passing an empty element loop.
    if (Object.prototype.hasOwnProperty.call(schema, "minItems")) {
      if (typeof schema.minItems !== "number" || !Number.isInteger(schema.minItems) || schema.minItems < 0) {
        throw new SchemaError(`minItems at ${path || "#"} must be a non-negative integer`);
      }
      if (value.length < schema.minItems) {
        errors.push({
          path: path || "#",
          message: `must have at least ${schema.minItems} item(s), got ${value.length}`,
        });
      }
    }
    let prefixLen = 0;
    if (Object.prototype.hasOwnProperty.call(schema, "prefixItems")) {
      if (!Array.isArray(schema.prefixItems)) {
        throw new SchemaError(`prefixItems at ${path || "#"} must be an array`);
      }
      prefixLen = schema.prefixItems.length;
      for (let i = 0; i < prefixLen && i < value.length; i++) {
        validateNode(value[i], schema.prefixItems[i], joinPath(path, String(i)), registry, errors);
      }
    }
    if (Object.prototype.hasOwnProperty.call(schema, "items")) {
      for (let i = prefixLen; i < value.length; i++) {
        validateNode(value[i], schema.items, joinPath(path, String(i)), registry, errors);
      }
    }
  }
}

/** Validate against a subtree but capture (not throw) its errors — for oneOf/anyOf branches. */
function validateSubtree(value, schema, path, registry) {
  const branchErrors = [];
  validateNode(value, schema, path, registry, branchErrors);
  return branchErrors;
}

function joinPath(base, key) {
  return base ? `${base}.${key}` : key;
}
