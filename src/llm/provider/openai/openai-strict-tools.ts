/**
 * OpenAI **strict function tools** — `tools[].function.strict: true`.
 *
 * Some models call tools reliably only when the provider constrains
 * decoding to the function's `parameters` schema. That is what OpenAI's
 * strict mode does, and models built for it (Inception Labs' Mercury was
 * the report that prompted this) produce a stream of malformed calls
 * without it. `strict` is a field on **each tool**, not a top-level body
 * field, so the entry's `extraBody` passthrough cannot reach it:
 * `tools` is in `RESERVED_BODY_KEYS` and is re-applied over the merge
 * (`openai-build-body.ts`). Hence a real knob — `strictTools` on the
 * provider entry — and this transform.
 *
 * Strict mode is not a flag you can set over an arbitrary schema. The
 * provider validates the schema itself and rejects the **whole request**
 * with a 400 when it does not conform, so a transform that is merely
 * optimistic is worse than no feature at all. The rules, applied
 * recursively to every object schema:
 *
 *   - `additionalProperties: false` on every object;
 *   - every key of `properties` listed in `required` — optionality is
 *     expressed by widening the value's type with `"null"`, never by
 *     leaving a key out of `required`;
 *   - only keywords strict mode is known to accept survive.
 *
 * **Kept verbatim:** `type`, `enum`, `description`, `title`, `$ref`
 * (plus `$defs`, recursed). **Recursed:** `properties`, `items`,
 * `anyOf`. `oneOf` is renamed to `anyOf` — the two are interchangeable
 * for a constrained decoder and `anyOf` is the spelling strict mode
 * documents. **Recomputed:** `required`, `additionalProperties`.
 *
 * **Stripped:** every remaining keyword. In this repo's tool schemas
 * that is exactly `minItems`, `maxItems` and `minimum` (a scan of all
 * 85 bundled descriptors); the wider strip list covers what an
 * MCP server's `inputSchema` may carry — `minLength`, `maxLength`,
 * `pattern`, `format`, `default`, `examples`, `const`, `uniqueItems`,
 * `multipleOf`, `exclusive*`, `$schema`, and so on. Dropping them is
 * safe here for the reason `default-tool-args-schemas.ts` states in its
 * own header: these schemas guard the **shape**, and the runtime
 * validators — not the provider — do the value-range checks. A dropped
 * bound loosens the schema; it never invalidates a call the agent would
 * otherwise have accepted.
 *
 * **Refused rather than mangled.** Some schemas cannot be expressed
 * under strict mode at all, and for those the function is emitted with
 * `strict: false` and its schema untouched — a `tools` array may mix
 * strict and non-strict functions. Refusal cases:
 *
 *   - a free-form object: no declared `properties` and
 *     `additionalProperties` not `false`. Closing it would leave a
 *     schema that admits only `{}`, silently deleting the tool's
 *     arguments. This is the `descriptorToJsonSchema` fallback branch
 *     (`{ type: "object", properties: {}, additionalProperties: true }`,
 *     used for any descriptor with no `argsJsonSchema`), and it is also
 *     real *nested*: `os.http.request.headers`, `mcp.prompt.get`'s
 *     `arguments` and `os.http.request.body`'s object branch are
 *     free-form maps carrying the tool's actual payload;
 *   - a typed open map (`additionalProperties` is a schema object) —
 *     same argument, the map is the payload;
 *   - composition strict mode does not model (`allOf`, `not`,
 *     `if`/`then`/`else`), tuple `items`, an array without `items`, or a
 *     schema with no `type`/`anyOf`/`$ref`/`enum` to constrain it at all.
 *
 * An object that declares properties *and* `additionalProperties: true`
 * is closed rather than refused: the declared keys are the tool's whole
 * documented contract (`os.fs.archive.extract.limits` is the only one),
 * so forbidding extras loses nothing a caller was entitled to send.
 *
 * The transform is idempotent — `f(f(x)) === f(x)` — because a
 * converted object already lists every property in `required`, so the
 * null-widening pass finds nothing left to widen.
 */

type Schema = Record<string, unknown>;

/**
 * Keywords copied straight through. Deliberately short: anything absent
 * here is dropped, so a new JSON Schema keyword arriving from an MCP
 * server degrades to "ignored", never to "sent and 400'd".
 */
const KEPT_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "enum",
  "description",
  "title",
  "$ref",
]);

/**
 * Composition strict mode does not model. Presence of any of these
 * means the schema cannot be converted — dropping them would change
 * what the tool accepts, which is not ours to decide.
 */
const UNSUPPORTED_COMPOSITION: readonly string[] = [
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "dependentRequired",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
];

export type StrictParametersResult = {
  /** Schema to send. Byte-identical to the input when `strict` is false. */
  parameters: Schema;
  /** Whether the function may carry `strict: true`. */
  strict: boolean;
};

function isPlainObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeIncludes(schema: Schema, wanted: string): boolean {
  const type = schema.type;
  if (typeof type === "string") return type === wanted;
  if (Array.isArray(type)) return type.includes(wanted);
  return false;
}

function enumWithNull(values: readonly unknown[]): unknown[] {
  return values.includes(null) ? [...values] : [...values, null];
}

/**
 * Widens a converted schema so it also accepts `null` — how strict mode
 * spells "this parameter is optional". Returns the input unchanged when
 * it is already nullable, which is what keeps the whole transform
 * idempotent even if a caller runs it twice.
 */
function widenWithNull(schema: Schema): Schema | undefined {
  const type = schema.type;
  if (typeof type === "string") {
    if (type === "null") return schema;
    const widened: Schema = { ...schema, type: [type, "null"] };
    if (Array.isArray(schema.enum)) widened.enum = enumWithNull(schema.enum);
    return widened;
  }
  if (Array.isArray(type)) {
    if (type.includes("null")) return schema;
    const widened: Schema = { ...schema, type: [...type, "null"] };
    if (Array.isArray(schema.enum)) widened.enum = enumWithNull(schema.enum);
    return widened;
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as unknown[];
    const alreadyNullable = branches.some(
      (branch) => isPlainObject(branch) && typeIncludes(branch, "null"),
    );
    if (alreadyNullable) return schema;
    return { ...schema, anyOf: [...branches, { type: "null" }] };
  }
  // No `type` and no `anyOf` to widen in place — a `$ref` or a bare
  // `enum`. Wrap it in a union instead, hoisting the prose so the
  // parameter keeps its description where a reader (and the model)
  // expects it.
  const { description, title, ...rest } = schema;
  if (Object.keys(rest).length === 0) return undefined;
  const wrapped: Schema = {};
  if (description !== undefined) wrapped.description = description;
  if (title !== undefined) wrapped.title = title;
  wrapped.anyOf = [rest, { type: "null" }];
  return wrapped;
}

/**
 * Converts one schema node, or returns `undefined` when strict mode
 * cannot express it. `undefined` propagates up to the tool, which is
 * then emitted non-strict rather than sent in a shape the provider
 * would reject.
 */
function convert(node: unknown): Schema | undefined {
  if (!isPlainObject(node)) return undefined;
  for (const keyword of UNSUPPORTED_COMPOSITION) {
    if (keyword in node) return undefined;
  }
  const out: Schema = {};
  for (const key of Object.keys(node)) {
    if (KEPT_KEYWORDS.has(key)) out[key] = node[key];
  }

  if ("$defs" in node) {
    if (!isPlainObject(node.$defs)) return undefined;
    const defs: Schema = {};
    for (const [name, def] of Object.entries(node.$defs)) {
      const converted = convert(def);
      if (!converted) return undefined;
      defs[name] = converted;
    }
    out.$defs = defs;
  }

  const branches = node.anyOf ?? node.oneOf;
  if (branches !== undefined) {
    if (!Array.isArray(branches) || branches.length === 0) return undefined;
    const converted: Schema[] = [];
    for (const branch of branches) {
      const child = convert(branch);
      if (!child) return undefined;
      converted.push(child);
    }
    out.anyOf = converted;
  }

  if (typeIncludes(node, "object") || isPlainObject(node.properties)) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const keys = Object.keys(properties);
    // A typed open map (`additionalProperties: { type: "string" }`) is
    // the payload, not decoration — refuse rather than delete it.
    if (isPlainObject(node.additionalProperties)) return undefined;
    // Nothing declared and not already closed: closing it would admit
    // only `{}`. A schema that is *already* `additionalProperties:
    // false` with no properties is a legitimate zero-argument tool.
    if (keys.length === 0 && node.additionalProperties !== false) {
      return undefined;
    }
    const originallyRequired = new Set(
      Array.isArray(node.required)
        ? node.required.filter(
            (name): name is string => typeof name === "string",
          )
        : [],
    );
    const outProperties: Schema = {};
    for (const key of keys) {
      let child = convert(properties[key]);
      if (!child) return undefined;
      if (!originallyRequired.has(key)) {
        child = widenWithNull(child);
        if (!child) return undefined;
      }
      outProperties[key] = child;
    }
    out.properties = outProperties;
    out.required = keys;
    out.additionalProperties = false;
    if (out.type === undefined) out.type = "object";
  }

  if (typeIncludes(node, "array")) {
    // Tuple validation (`items` as an array) and an unconstrained array
    // are both outside strict mode.
    if (!isPlainObject(node.items)) return undefined;
    const items = convert(node.items);
    if (!items) return undefined;
    out.items = items;
  }

  // Nothing left that constrains anything — an empty schema means
  // "any value", which is exactly what strict mode exists to forbid.
  if (
    out.type === undefined &&
    out.anyOf === undefined &&
    out.$ref === undefined &&
    out.enum === undefined
  ) {
    return undefined;
  }
  return out;
}

/**
 * Rewrites one function's `parameters` for strict mode. The root must
 * be an object schema — OpenAI requires it — so anything else is
 * refused and travels unchanged with `strict: false`.
 */
export function toStrictParameters(schema: Schema): StrictParametersResult {
  const fallback: StrictParametersResult = {
    parameters: schema,
    strict: false,
  };
  if (!typeIncludes(schema, "object") && !isPlainObject(schema.properties)) {
    return fallback;
  }
  const converted = convert(schema);
  if (!converted) return fallback;
  return { parameters: converted, strict: true };
}

/**
 * Marks every OpenAI function tool strict where its schema allows it.
 * Entries whose schema cannot be converted keep their schema and are
 * marked `strict: false` explicitly — the documented default, and it
 * tells a reader looking at a request dump which tools are constrained
 * and which are not.
 */
export function toStrictOpenAiTools(
  tools: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  return tools.map((tool) => {
    const fn = tool.function;
    if (tool.type !== "function" || !isPlainObject(fn)) return tool;
    if (!isPlainObject(fn.parameters)) return tool;
    const { parameters, strict } = toStrictParameters(fn.parameters);
    return { ...tool, function: { ...fn, parameters, strict } };
  });
}

/**
 * The other half of the bargain strict mode strikes.
 *
 * Because an optional parameter is expressed as "required, but may be
 * `null`", a model under strict mode stops omitting keys and starts
 * sending `"pinned": null`. That is a real behaviour change on the
 * *response* side, and a tool that branches on presence rather than on
 * value takes the "the caller asked for this" branch with nothing to
 * put in it. `memory.profile.set` is the live example: `parseSetOptions`
 * gates on `rawArgs.pinned !== undefined` and then demands a boolean, so
 * an explicit null turns a well-formed call into a validation error.
 * (`os.git.init` reads the same way at a glance but is safe — its own
 * `optionalString` maps `null` to `undefined` before the presence check.)
 *
 * So when strict tools are on, a top-level `null` argument is dropped
 * and the call reads exactly as it did before: the key is absent.
 *
 * **Top-level only**, with two consequences worth naming rather than
 * implying:
 *
 *   - A null nested inside an argument survives. That is usually right
 *     — it is data the model meant to send — but this transform does
 *     widen nested optionals too, so it is not only third-party
 *     schemas that can produce one. In this repo the nested nullables
 *     are `os.fs.archive.extract.limits.{maxEntries,maxEntryBytes,
 *     maxTotalBytes}` and `fusion.delegate.tasks[].{deliverable,files}`;
 *     all five readers (`readLimit`, `readString`, `readFiles`) already
 *     map `null` to their default, so nothing is broken today. A new
 *     nested optional whose reader gates on `!== undefined` would be.
 *   - The drop rides on the tool-call adapter, so it covers the
 *     `tool_calls` envelope only. `step-executor.ts` has two content
 *     recovery paths (a GBNF-style array in `content`, and the same in
 *     `reasoning_content`) that build a batch from the grammar parser
 *     and use the adapter for `nameUnescape` alone — a null the model
 *     puts in *those* reaches the tool unfiltered.
 */
export function withoutTopLevelNullArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  let dropped = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null) {
      dropped = true;
      continue;
    }
    out[key] = value;
  }
  return dropped ? out : args;
}
