/**
 * Boolean subschemas out of tool `parameters` (ATO-1399).
 *
 * JSON Schema lets any subschema be a bare `true` ("anything") or
 * `false` ("nothing"), and MCP servers do send them: the report was a
 * plugin tool with `$defs.RecordSource.oneOf[1].properties.evidence:
 * true`. llama.cpp's schema-to-grammar converter and LM Studio's
 * validator both demand an object at every subschema position and
 * answer the **whole request** with an error ("JSON schema error at
 * #/$defs/RecordSource/oneOf/1/properties/evidence: schema must be an
 * object"), so one third-party tool took the chat down with it.
 *
 * The rewrite, applied recursively to every subschema position:
 *
 *   - `true` becomes `{}`: the same schema, spelled as an object.
 *     Where the keyword itself is optional (`items`, an `allOf`
 *     member) it is dropped instead.
 *   - `false` under `properties` / `patternProperties` /
 *     `dependentSchemas` drops the entry (and the name from
 *     `required`); under `anyOf` / `oneOf` drops the branch. As
 *     `items` it becomes `maxItems`: the `prefixItems` length (0 with
 *     no tuple); `not: false` is dropped.
 *   - any other `false` becomes `{ not: {} }`.
 *
 * Every `false` rewrite either keeps the meaning or **loosens** it (a
 * forbidden key becomes merely undeclared). That is safe for the reason
 * `openai-strict-tools.ts` gives for its stripped bounds: the schema
 * steers the model's decoding, and the tool's own validator still
 * checks every call.
 *
 * Kept as booleans: `additionalProperties`, `additionalItems`,
 * `unevaluatedProperties`, `unevaluatedItems`. There a boolean is the
 * keyword's documented value and llama.cpp reads it as such.
 *
 * Copy-on-write: the input is never mutated, and a schema with nothing
 * to rewrite comes back as the same reference, so a request whose tools
 * carry no boolean subschema is byte-identical to what it was.
 */

type Schema = Record<string, unknown>;

/** Past this depth a schema is returned as it is rather than recursed. */
const MAX_DEPTH = 64;

/** Keywords whose value is one subschema. */
const SINGLE_SCHEMA_KEYWORDS = [
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
] as const;

/** Keywords whose boolean value is legal and kept; objects are recursed. */
const BOOLEAN_OK_KEYWORDS = [
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
] as const;

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A subschema in a position where a boolean has no shorter spelling. */
function asObject(value: unknown, depth: number): unknown {
  if (value === true) return {};
  if (value === false) return { not: {} };
  return normalizeNode(value, depth);
}

/** A name -> schema map; `false` entries are dropped and reported. */
function normalizeMap(map: Schema, depth: number, dropped: string[]): Schema {
  let out: Schema | undefined;
  for (const [key, child] of Object.entries(map)) {
    const next = child === false ? undefined : asObject(child, depth);
    if (next === child) continue;
    out ??= { ...map };
    if (next === undefined) {
      delete out[key];
      dropped.push(key);
    } else {
      out[key] = next;
    }
  }
  return out ?? map;
}

/** `anyOf` / `oneOf` / `allOf` / `prefixItems` / tuple `items`. */
function normalizeList(
  list: readonly unknown[],
  depth: number,
  drop: (value: unknown) => boolean,
): readonly unknown[] {
  let changed = false;
  const out: unknown[] = [];
  for (const child of list) {
    if (drop(child)) {
      changed = true;
      continue;
    }
    const next = asObject(child, depth);
    if (next !== child) changed = true;
    out.push(next);
  }
  return changed ? out : list;
}

function normalizeNode(node: unknown, depth: number): unknown {
  if (!isPlainObject(node) || depth > MAX_DEPTH) return node;
  const next = depth + 1;
  let out: Schema | undefined;
  const set = (key: string, value: unknown) => {
    if (value === node[key]) return;
    out ??= { ...node };
    if (value === undefined) delete out[key];
    else out[key] = value;
  };

  if (isPlainObject(node.properties)) {
    const dropped: string[] = [];
    set("properties", normalizeMap(node.properties, next, dropped));
    if (dropped.length > 0 && Array.isArray(node.required)) {
      const gone = new Set<unknown>(dropped);
      set("required", node.required.filter((name) => !gone.has(name)));
    }
  }
  if (isPlainObject(node.patternProperties)) {
    set("patternProperties", normalizeMap(node.patternProperties, next, []));
  }
  if (isPlainObject(node.dependentSchemas)) {
    // `true` adds no constraint and `false` forbids the key: dropping the
    // entry keeps the first and loosens the second.
    const deps = node.dependentSchemas;
    const kept = Object.fromEntries(
      Object.entries(deps).filter(([, child]) => typeof child !== "boolean"),
    );
    const base =
      Object.keys(kept).length === Object.keys(deps).length ? deps : kept;
    set("dependentSchemas", normalizeMap(base, next, []));
  }
  for (const key of ["$defs", "definitions"] as const) {
    const defs = node[key];
    if (!isPlainObject(defs)) continue;
    // A `$ref` may point at any entry, so none is dropped.
    let copy: Schema | undefined;
    for (const [name, def] of Object.entries(defs)) {
      const value = asObject(def, next);
      if (value === def) continue;
      copy ??= { ...defs };
      copy[name] = value;
    }
    if (copy) set(key, copy);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    const kept = normalizeList(list, next, (v) => v === false);
    set(key, kept.length > 0 ? kept : [{ not: {} }]);
  }
  if (Array.isArray(node.allOf)) {
    const kept = normalizeList(node.allOf, next, (v) => v === true);
    set("allOf", kept.length > 0 ? kept : undefined);
  }
  if (Array.isArray(node.prefixItems)) {
    set("prefixItems", normalizeList(node.prefixItems, next, () => false));
  }
  if (node.items === true) {
    set("items", undefined);
  } else if (node.items === false) {
    // No items past the tuple: with `prefixItems` that is its length
    // (kept tighter if a `maxItems` already says so), without it none.
    set("items", undefined);
    const tuple = Array.isArray(node.prefixItems) ? node.prefixItems.length : 0;
    const cap =
      typeof node.maxItems === "number" ? Math.min(node.maxItems, tuple) : tuple;
    set("maxItems", cap);
  } else if (Array.isArray(node.items)) {
    set("items", normalizeList(node.items, next, () => false));
  } else if (isPlainObject(node.items)) {
    set("items", normalizeNode(node.items, next));
  }
  if (node.not === false) set("not", undefined);
  else if ("not" in node) set("not", asObject(node.not, next));
  for (const key of SINGLE_SCHEMA_KEYWORDS) {
    if (key in node) set(key, asObject(node[key], next));
  }
  for (const key of BOOLEAN_OK_KEYWORDS) {
    if (isPlainObject(node[key])) set(key, normalizeNode(node[key], next));
  }
  return out ?? node;
}

/**
 * One function's `parameters`, with every boolean subschema rewritten.
 * A boolean root (never a valid function schema) becomes an open object.
 */
export function normalizeSchemaBooleans(schema: unknown): unknown {
  if (typeof schema === "boolean") return { type: "object" };
  return normalizeNode(schema, 0);
}

/**
 * Every OpenAI function tool with its `parameters` normalized. Returns
 * the input array itself when no tool needed a change.
 */
export function normalizeToolSchemaBooleans<T extends Record<string, unknown>>(
  tools: ReadonlyArray<T>,
): ReadonlyArray<T> {
  let out: T[] | undefined;
  tools.forEach((tool, index) => {
    const fn = tool.function;
    if (!isPlainObject(fn) || !("parameters" in fn)) return;
    const parameters = normalizeSchemaBooleans(fn.parameters);
    if (parameters === fn.parameters) return;
    out ??= [...tools];
    out[index] = { ...tool, function: { ...fn, parameters } };
  });
  return out ?? tools;
}
