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
 * `minLength: 1`, `fusion.delegate` carries `minItems`/`maxItems` — and
 * a descriptor with no registered schema falls back to an open
 * `{ properties: {}, additionalProperties: true }` object, which has no
 * strict form at all short of declaring the tool zero-argument.
 *
 * A value-range bound is STRIPPED rather than refused over: the
 * compiler ignores it either way, so refusing over one would cost the
 * tool its constraint and enforce nothing in exchange — see
 * `STRIPPED_BOUNDS` for why that is safe and what stays a refusal.
 * Everything else the compiler has no rule for still refuses, and the
 * refusal is per tool: this returns `null` for anything it cannot
 * rewrite faithfully, and the caller leaves that one function exactly
 * as it ships today. A `tools` array mixing strict and non-strict
 * functions is legal, and a partial win beats a 400 on every request —
 * which is what a whole-array flag would buy, and is strictly worse for
 * the operator than the bug.
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
 * The keyword allowlist IS the safety property. Anything outside it and
 * outside the two strip lists below — a `$ref`, a `oneOf`, a `const`, a
 * vendor extension on a third-party MCP schema — means we do not know
 * what the provider's compiler will do with the node, so the tool keeps
 * its current non-strict definition instead of gambling the request on
 * it.
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
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentEncoding",
  "contentMediaType",
]);

/**
 * Value-range keywords: stripped, not refused over.
 *
 * These constrain a value the decode has already got the *shape* of.
 * The strict compiler implements none of them, so they cannot be sent;
 * the question is only whether the tool keeps them and loses strict, or
 * loses them and keeps strict. Refusing buys nothing, because a strict
 * decode never enforced the bound in the first place — the tool ends up
 * unconstrained AND unbounded instead of constrained and unbounded.
 *
 * Dropping one is safe for the reason `default-tool-args-schemas.ts`
 * states in its own header: these schemas guard shape, and every bound
 * they carry is re-checked by the tool's own parser, which is what
 * actually rejects a bad call today (the provider never saw the schema
 * at all before this feature). Checked one by one for the three
 * built-ins this recovers: `reply`'s `minLength: 1` is re-enforced by
 * the batch validator's non-empty `text` rule, `vision.describe`'s
 * `maxItems` by `maxImagesPerCall`, and `fusion.delegate`'s
 * `minItems`/`maxItems`/`minimum` by `parseDelegateArgs`
 * (`MAX_DELEGATE_TASKS`, `MAX_TASK_FILES`, `maxWorkers < 1`).
 *
 * Deliberately NOT here: `const`. It reads like an annotation and is
 * not one — it pins a value the way a one-member `enum` does, and
 * dropping it would let the model send anything at all where the schema
 * named one thing. That is a change to what the tool accepts, so it
 * stays a refusal. No built-in uses it.
 *
 * Stripping cannot disturb the null-drop bookkeeping: a bound says
 * nothing about whether a property is in `required`, so
 * `strictWidenedProperties` — which reads the ORIGINAL schema's
 * `properties` and `required` and nothing else — returns the same set
 * either way.
 */
const STRIPPED_BOUNDS: ReadonlySet<string> = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
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
 * Every node this module emits is spread (`{ ...node, ... }`) so the
 * annotations it accepts survive. That spread is also how an
 * allowlisted keyword the node's SHAPE has no rule for would ride out
 * into a schema we then mark strict, unconverted — `enum` on an object
 * node emitting its raw sub-objects verbatim is the sharp case, and
 * `items` on an object (or `properties` on an array) is the same bug
 * with a different key. `convertScalar` has always refused its own
 * strays; these are the other three shapes' lists, so the keyword
 * allowlist means what the module's header says it means.
 *
 * `enum` appears in all three: a non-scalar enum member is a whole
 * sub-value we would have to convert and do not.
 */
const UNION_STRAYS: readonly string[] = [
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
];
const ARRAY_STRAYS: readonly string[] = [
  "properties",
  "required",
  "additionalProperties",
  "enum",
];
const OBJECT_STRAYS: readonly string[] = ["items", "enum"];

function hasStrayKeyword(node: Schema, strays: readonly string[]): boolean {
  return strays.some((key) => node[key] !== undefined);
}


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

/**
 * The top-level property names whose OPTIONALITY this conversion
 * erases: exactly those `toStrictJsonSchema` moves into `required` and
 * unions with `null` because the original schema left them out of
 * `required`.
 *
 * This, and not "the tool converted", is what the null-drop on the way
 * back in must be keyed to — see `openAiToolCallsToBatch`. A property
 * that was ALREADY required is emitted byte-identical, nullable or not,
 * so a `null` the model sends for it is a `null` the tool's own schema
 * asked for. `z.string().nullable()` in the official MCP SDK produces
 * exactly that shape (`anyOf: [{string},{null}]`, listed in `required`),
 * and deleting its key would hand the server a call missing a required
 * field.
 *
 * Only meaningful for a schema `toStrictJsonSchema` accepted; call it
 * on the same input and only when that returned non-null.
 */
export function strictWidenedProperties(schema: unknown): ReadonlySet<string> {
  const root = asObject(schema);
  const properties = asObject(root?.properties);
  if (!properties) return EMPTY_NAMES;
  const required = readRequired(root?.required);
  if (!required) return EMPTY_NAMES;
  const widened = new Set<string>();
  for (const name of Object.keys(properties)) {
    if (!required.has(name)) widened.add(name);
  }
  return widened;
}

const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

function convertNode(raw: Schema, depth: number): Schema | null {
  if (depth > MAX_NESTING) return null;
  const node = stripAnnotations(raw);
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) return null;
  }
  if (node.anyOf !== undefined) {
    // A union node carries its branches and nothing else structural;
    // `type` alongside `anyOf` is a shape we do not emit and will not
    // guess at, and the rest would ride out through the spread below
    // unconverted.
    if (node.type !== undefined || !Array.isArray(node.anyOf)) return null;
    if (hasStrayKeyword(node, UNION_STRAYS)) return null;
    const branches: Schema[] = [];
    for (const branchRaw of node.anyOf) {
      const branch = asObject(branchRaw);
      if (!branch) return null;
      // `depth + 1`, not `depth`: a branch is a nesting level like any
      // other. Recursing at the same depth left the bound unenforced on
      // this path, so a self-referential `anyOf` still overflowed the
      // stack and an arbitrarily deep union chain still converted.
      const converted = convertNode(branch, depth + 1);
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
    if (hasStrayKeyword(node, ARRAY_STRAYS)) return null;
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

/**
 * Whether an object that did NOT say `additionalProperties: false` may
 * still be closed. Strict mode has one spelling for an object and it is
 * the closed one, so the alternative is refusing the whole tool.
 *
 * Exactly one shape qualifies: an explicit `additionalProperties: true`
 * on a node that also declares at least one property. The author wrote
 * both halves by hand, the declared list is the tool's whole documented
 * contract, and the model is never shown anything else — so forbidding
 * extras takes away only keys it had no way to know about.
 * `os.fs.archive.extract.limits` is the built-in, and its reader
 * (`parseLimits`) looks at the three declared keys and ignores the rest,
 * so closing it is observably a no-op.
 *
 * Two neighbours stay refusals, and the line between them is about
 * exposure rather than semantics — JSON Schema says an absent
 * `additionalProperties` and an explicit `true` mean the same thing:
 *
 *   * `properties: {}` with `true`. That is `descriptorToJsonSchema`'s
 *     fallback for a descriptor with no registered schema, and closing
 *     it would mark a tool strict as taking no arguments at all,
 *     deleting every argument it does take.
 *   * an ABSENT `additionalProperties`. Same semantics as `true`, very
 *     different provenance: it is what pydantic/FastMCP emit for every
 *     model, i.e. the default of a generator rather than a statement by
 *     an author, and it is the majority shape among third-party MCP
 *     `inputSchema`s. Refusing there keeps this rule's blast radius to
 *     schemas somebody actually typed `true` into.
 *
 * A schema-valued `additionalProperties` (`{ type: "string" }`) is a
 * typed open map — the map IS the payload — and is refused by both
 * checks below.
 */
function canClose(node: Schema, properties: Schema): boolean {
  return (
    node.additionalProperties === true && Object.keys(properties).length > 0
  );
}

function convertObject(node: Schema, depth: number): Schema | null {
  if (hasStrayKeyword(node, OBJECT_STRAYS)) return null;
  // `properties` absent means an object of unknown shape, and there is
  // no strict form of that short of declaring it zero-argument. The
  // real zero-argument tools spell it out as an explicit `{}`.
  const properties =
    node.properties === undefined ? null : asObject(node.properties);
  if (properties === null) return null;
  if (node.additionalProperties !== false && !canClose(node, properties)) {
    return null;
  }

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

/**
 * A copy of `node` without the keywords we accept but do not emit: the
 * annotations that carry no constraint, and the value-range bounds the
 * strict compiler has no rule for. Returns the input itself when there
 * is nothing to remove, so the common node allocates nothing.
 */
function stripAnnotations(node: Schema): Schema {
  let out: Schema | null = null;
  for (const key of Object.keys(node)) {
    if (!DROPPED_KEYWORDS.has(key) && !STRIPPED_BOUNDS.has(key)) continue;
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
