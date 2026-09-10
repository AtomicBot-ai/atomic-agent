/**
 * Rewrites a tool's args schema into the shape OpenAI-compatible
 * providers accept under `strict: true`, or refuses.
 *
 * Strict mode is not a flag that can be hung on an arbitrary JSON
 * Schema. The provider compiles the schema into a decoding constraint
 * and rejects the whole request when it cannot: every object must close
 * itself with `additionalProperties: false`, must list *every* declared
 * property in `required`, and the schema may use none of the validation
 * keywords the compiler does not implement (`minLength`, `minItems`,
 * `maxItems`, `pattern`, `format`, `$ref`, ...). Our descriptors were
 * written for plain validation and use those freely — `reply` carries
 * `minLength: 1`, `fusion.delegate` carries `minItems`/`maxItems`, and
 * a descriptor with no registered schema falls back to an open
 * `{ additionalProperties: true }` object, which has no strict form at
 * all short of declaring the tool zero-argument.
 *
 * So the conversion is per tool and the refusal is per tool: this
 * returns `null` for anything it cannot rewrite faithfully, and the
 * caller leaves that one function exactly as it ships today. A `tools`
 * array mixing strict and non-strict functions is legal, and a partial
 * win beats a 400 on every request — which is what a whole-array flag
 * would buy, and is strictly worse for the operator than the bug.
 *
 * The one rewrite that is not a pure no-op is optionality. Strict has
 * no notion of an absent key, so an optional property is unioned with
 * `null` and moved into `required`; the model then answers with an
 * explicit `null` where it used to omit the key. Several tools read
 * their raw args with `!== undefined` (`memory.profile.set.pinned`,
 * `memory.notes.recall.id`) and would take a branch they must not on a
 * literal `null`, which is why the adapter drops null-valued arguments
 * on the way back in — see `openAiToolCallsToBatch`.
 */

type Schema = Record<string, unknown>;

/**
 * The keyword allowlist IS the safety property. Anything outside it —
 * a bound, a `pattern`, a `$ref`, a `oneOf`, a vendor extension on a
 * third-party MCP schema — means we do not know what the provider's
 * compiler will do with the node, so the tool keeps its current
 * non-strict definition instead of gambling the request on it.
 */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "anyOf",
]);

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
]);

/**
 * The strict form of `schema`, or `null` when it cannot be produced.
 * The input is never mutated: every node is rebuilt.
 */
export function toStrictJsonSchema(schema: unknown): Schema | null {
  const root = asObject(schema);
  if (!root || root.type !== "object") return null;
  return convertNode(root);
}

function convertNode(node: Schema): Schema | null {
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return null;
  }
  if (node.anyOf !== undefined) {
    // A union node carries its branches and nothing else structural;
    // `type` alongside `anyOf` is a shape we do not emit and will not
    // guess at.
    if (node.type !== undefined || !Array.isArray(node.anyOf)) return null;
    const branches: Schema[] = [];
    for (const raw of node.anyOf) {
      const branch = asObject(raw);
      if (!branch) return null;
      const converted = convertNode(branch);
      if (!converted) return null;
      branches.push(converted);
    }
    if (branches.length === 0) return null;
    return { ...node, anyOf: branches };
  }
  const type = node.type;
  if (typeof type !== "string") return null;
  if (SCALAR_TYPES.has(type)) {
    if (node.enum !== undefined && !Array.isArray(node.enum)) return null;
    return { ...node };
  }
  if (type === "array") {
    const items = asObject(node.items);
    if (!items) return null;
    const converted = convertNode(items);
    if (!converted) return null;
    return { ...node, items: converted };
  }
  if (type !== "object") return null;
  return convertObject(node);
}

function convertObject(node: Schema): Schema | null {
  // An open object is the case with no strict form: closing it would
  // silently forbid arguments the tool accepts today.
  if (
    node.additionalProperties !== undefined &&
    node.additionalProperties !== false
  ) {
    return null;
  }
  // `properties` absent means an object of unknown shape — same story.
  // The zero-argument tools spell that out as an explicit `{}`.
  const properties =
    node.properties === undefined ? null : asObject(node.properties);
  if (properties === null) return null;

  const required = readRequired(node.required);
  if (!required) return null;

  const out: Schema = {};
  for (const [name, raw] of Object.entries(properties)) {
    const child = asObject(raw);
    if (!child) return null;
    const converted = convertNode(child);
    if (!converted) return null;
    out[name] = required.has(name) ? converted : nullable(converted);
    required.delete(name);
  }
  // A `required` entry with no matching property is rejected by the
  // compiler, and it is a bug in the descriptor either way.
  if (required.size > 0) return null;

  return {
    ...node,
    type: "object",
    properties: out,
    required: Object.keys(out),
    additionalProperties: false,
  };
}

/**
 * Widen a node so it also accepts `null` — how an optional property
 * survives being forced into `required`. An enum has to admit `null`
 * as a member too, or the widened type and the enum contradict each
 * other and nothing validates.
 */
function nullable(node: Schema): Schema {
  if (Array.isArray(node.anyOf)) {
    return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  const widened: Schema = { ...node, type: [node.type, "null"] };
  if (Array.isArray(node.enum)) widened.enum = [...node.enum, null];
  return widened;
}

function readRequired(value: unknown): Set<string> | null {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    names.add(entry);
  }
  return names;
}

function asObject(value: unknown): Schema | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : null;
}
