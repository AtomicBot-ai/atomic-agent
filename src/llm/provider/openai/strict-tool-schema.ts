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
 * of the tools it converted on the way back in — see
 * `openAiToolCallsToBatch`. Because that undo is keyed to exactly the
 * functions this module rewrote, the rewrite is invisible from a
 * tool's point of view: it sees the same absent key it sees today.
 *
 * Nullability is the one place where "faithful" needs stating twice.
 * A schema may already be nullable in any of the three standard
 * spellings — `type: ["string", "null"]`, `anyOf` with a
 * `{ type: "null" }` branch, or a bare `{ type: "null" }` — and all
 * three are accepted, left alone when they are already what we would
 * produce, and never widened twice. That is what makes the conversion
 * idempotent (feed our own output back in and it comes out unchanged)
 * and what makes it usable on the pydantic/FastMCP schemas an MCP
 * server actually ships, where `Optional[str]` is the common case.
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

/**
 * Accepted, then dropped from the node we emit: annotations that carry
 * no constraint, that the strict compiler has no rule for, and that
 * pydantic-generated MCP schemas put on almost every property.
 *
 * `default` is the interesting one. Under strict there is no absent
 * key for a default to fill, so passing it through would state
 * something the decode cannot honour; dropping it loses nothing,
 * because the null the model sends for an unset optional is deleted
 * again in `openAiToolCallsToBatch` and the tool (or the MCP server)
 * applies its own default to the absent key exactly as it does today.
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  "default",
  "$schema",
  "$comment",
]);

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
]);

/**
 * How deep a schema may nest and still convert.
 *
 * The keyword allowlist bounds *what* a node may say; nothing bounded
 * how many of them there are, and the built-in descriptors (deepest:
 * `os.shell.run`, two levels) hid that. A third-party MCP `inputSchema`
 * is not so polite. Two things go wrong without a bound, both of them
 * exactly the failure this module exists to avoid:
 *
 *   * strict compilers cap nesting — OpenAI documents a ceiling and
 *     other OpenAI-compatible vendors are not more generous — and a
 *     schema past it is rejected with the whole request, taking every
 *     other tool's definition down with it;
 *   * a self-referential node (an in-process descriptor, not something
 *     `JSON.parse` can build, but nothing here promised otherwise) ran
 *     the recursion into a `RangeError` that escaped
 *     `descriptorsToOpenAiTools` and killed the step.
 *
 * Five is the conservative reading of the published ceiling. Refusing a
 * deeper schema costs that one tool its strict marking and nothing else
 * — it ships exactly as it does today — so the cheap answer is the
 * right one.
 */
const MAX_NESTING = 5;


/**
 * The strict form of `schema`, or `null` when it cannot be produced.
 * The input is never mutated: every node is rebuilt.
 */
export function toStrictJsonSchema(schema: unknown): Schema | null {
  const root = asObject(schema);
  if (!root) return null;
  const stripped = stripAnnotations(root);
  if (stripped.type !== "object") return null;
  return convertNode(stripped, 0);
}

function convertNode(raw: Schema, depth: number): Schema | null {
  if (depth > MAX_NESTING) return null;
  const node = stripAnnotations(raw);
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return null;
  }
  if (node.anyOf !== undefined) {
    // A union node carries its branches and nothing else structural;
    // `type` alongside `anyOf` is a shape we do not emit and will not
    // guess at.
    if (node.type !== undefined || !Array.isArray(node.anyOf)) return null;
    const branches: Schema[] = [];
    for (const branchRaw of node.anyOf) {
      const branch = asObject(branchRaw);
      if (!branch) return null;
      const converted = convertNode(branch, depth);
      if (!converted) return null;
      branches.push(converted);
    }
    if (branches.length === 0) return null;
    return { ...node, anyOf: branches };
  }
  // `type` is either a name or a union spelled as an array of names —
  // `["string", "null"]` is `Optional[str]` as pydantic emits it, and
  // it is also what this module produces for an optional property, so
  // reading it back is what makes the conversion idempotent.
  const kinds = readTypeNames(node.type);
  if (!kinds) return null;
  const structural = kinds.filter((kind) => kind !== "null");
  // A leaf: scalars, `null`, or a union of those.
  if (structural.every((kind) => SCALAR_TYPES.has(kind))) {
    return convertScalar(node);
  }
  // Anything else has exactly one structural branch to convert; a
  // union of two structural types has one `items`/`properties` and no
  // way to say which branch it belongs to.
  if (structural.length !== 1) return null;
  if (structural[0] === "array") {
    const items = asObject(node.items);
    if (!items) return null;
    const converted = convertNode(items, depth + 1);
    if (!converted) return null;
    return { ...node, items: converted };
  }
  if (structural[0] !== "object") return null;
  return convertObject(node, depth);
}

/** `type` as a list of names, or `null` if it is not a legal `type`. */
function readTypeNames(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.length === 0) return null;
  const names: string[] = [];
  for (const member of value) {
    if (typeof member !== "string") return null;
    names.push(member);
  }
  return names;
}

/**
 * A leaf: a scalar, `null`, or a union of those. Emitted verbatim, so
 * refuse the structural keywords that would then ride through
 * unconverted — a `properties` or `items` hanging off a scalar node is
 * not a shape we can vouch for.
 */
function convertScalar(node: Schema): Schema | null {
  if (node.enum !== undefined && !Array.isArray(node.enum)) return null;
  if (node.properties !== undefined || node.items !== undefined) return null;
  if (node.additionalProperties !== undefined) return null;
  if (node.required !== undefined) return null;
  return { ...node };
}

function convertObject(node: Schema, depth: number): Schema | null {
  // An object that does not close itself is open — that is the JSON
  // Schema default, and an absent `additionalProperties` means it as
  // loudly as an explicit `true` does. Closing either one would
  // silently forbid arguments the tool accepts today, which on a
  // third-party MCP schema is exactly the failure this module exists
  // to refuse. Our own descriptors spell `additionalProperties: false`
  // out on every object (`default-tool-args-schemas.ts` conventions),
  // so requiring it costs the built-ins nothing.
  if (node.additionalProperties !== false) return null;
  // `properties` absent means an object of unknown shape — same story.
  // The zero-argument tools spell that out as an explicit `{}`.
  const properties =
    node.properties === undefined ? null : asObject(node.properties);
  if (properties === null) return null;

  const required = readRequired(node.required);
  if (!required) return null;

  // Built through entries rather than `out[name] = ...`: a property
  // literally named `__proto__` is a legal JSON Schema key and an
  // assignment would set the prototype instead of an own key, quietly
  // dropping the argument from a schema we then mark strict.
  // `Object.fromEntries` defines own properties and keeps it.
  const entries: [string, Schema][] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const child = asObject(raw);
    if (!child) return null;
    const converted = convertNode(child, depth + 1);
    if (!converted) return null;
    entries.push([name, required.has(name) ? converted : nullable(converted)]);
    required.delete(name);
  }
  // A `required` entry with no matching property is rejected by the
  // compiler, and it is a bug in the descriptor either way.
  if (required.size > 0) return null;

  return {
    // `type` is carried through rather than re-stated: an optional
    // object arrives back here as `["object", "null"]` and must keep
    // its null branch.
    ...node,
    properties: Object.fromEntries(entries),
    required: entries.map(([name]) => name),
    additionalProperties: false,
  };
}

/**
 * Widen a node so it also accepts `null` — how an optional property
 * survives being forced into `required`. An enum has to admit `null`
 * as a member too, or the widened type and the enum contradict each
 * other and nothing validates.
 *
 * Idempotent in all three spellings of "already nullable": a node that
 * admits `null` today comes back untouched, so converting our own
 * output (or a schema an MCP server already wrote in strict shape) is
 * a no-op rather than a double-widening the compiler would reject.
 */
function nullable(node: Schema): Schema {
  if (Array.isArray(node.anyOf)) {
    if (node.anyOf.some(isNullBranch)) return node;
    return { ...node, anyOf: [...node.anyOf, { type: "null" }] };
  }
  const type = node.type;
  if (type === "null") return node;
  if (Array.isArray(type)) {
    if (type.includes("null")) return node;
    return withNullEnum({ ...node, type: [...type, "null"] });
  }
  return withNullEnum({ ...node, type: [type, "null"] });
}

function withNullEnum(node: Schema): Schema {
  if (!Array.isArray(node.enum) || node.enum.includes(null)) return node;
  return { ...node, enum: [...node.enum, null] };
}

function isNullBranch(value: unknown): boolean {
  const branch = asObject(value);
  return branch?.type === "null";
}

/** A copy of `node` without the annotations we accept but do not emit. */
function stripAnnotations(node: Schema): Schema {
  let out: Schema | null = null;
  for (const key of Object.keys(node)) {
    if (!DROPPED_KEYWORDS.has(key)) continue;
    out ??= { ...node };
    delete out[key];
  }
  return out ?? node;
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
