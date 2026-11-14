import {
  coerceJsonSchemaValue,
  validateJsonSchemaValue,
} from "../llm/provider/openai/coerce-json-schema-value.js";
import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";

type Schema = Record<string, unknown>;

/**
 * Repairs tool arguments that arrived one level over-encoded.
 *
 * Models routinely emit a JSON value wrapped in a string: a number as
 * `"200000"`, an array as `"[\"a.png\"]"`, an object as
 * `"{\"User-Agent\":\"...\"}"`. The payload is valid JSON of the right
 * shape, but the tools' strict `typeof` checks reject it and the step
 * is wasted. This runs on every dispatch (see `ToolRegistry.invoke`)
 * and unwraps exactly that case.
 *
 * The rule is do-no-harm. A string is left alone whenever the declared
 * schema already accepts it as written, and any coercion failure keeps
 * the original value so the tool's own validation produces its normal
 * error. A tool with no registered schema passes through unchanged.
 */
export function coerceToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = argsProperties(name);
  if (!properties) return args;

  const normalised = normalizeArgKeys(args, properties);
  let coerced: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(normalised)) {
    if (typeof value !== "string") continue;
    const schema = asSchema(properties[key]);
    if (!schema) continue;

    const candidate = tryCoerce(value, schema);
    if (candidate === undefined) continue;

    coerced ??= { ...normalised };
    coerced[key] = candidate;
  }
  return coerced ?? normalised;
}

/**
 * Repairs argument *keys* that arrived mangled, the way models mangle
 * them: a key wrapped in its own quotes (`"\"path\""`), a key fused
 * with a fragment of the prompt's markup (`<label>…</label>,limit`) —
 * both seen from a cloud worker, both rejected as "`path` must be a
 * non-empty string" while the value sat under the mangled key — and a
 * camelCase key sent in snake_case (`timeout_ms` for `timeoutMs`, #901).
 *
 * Do-no-harm again: a key is renamed only when it is not itself in the
 * schema, its cleaned form (or that form in camelCase) is, and the model
 * did not also send that key. Anything else is left for the tool to
 * report — or, for a key that is still unknown after this pass, for the
 * executor to refuse before dispatch (`unknown-argument-guard.ts`), which
 * is why this runs first there too.
 */
export function normalizeArgKeys(
  args: Record<string, unknown>,
  properties: Schema,
): Record<string, unknown> {
  let fixed: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (Object.hasOwn(properties, key)) continue;
    const clean = normalizeKey(key);
    if (clean === null) continue;
    const target = schemaKeyFor(clean, properties);
    if (target === null || target === key || Object.hasOwn(args, target)) {
      continue;
    }
    fixed ??= { ...args };
    delete fixed[key];
    fixed[target] = value;
  }
  return fixed ?? args;
}

/**
 * The schema key a cleaned key names: itself when declared, else its
 * camelCase form when that is declared (`timeout_ms` → `timeoutMs`).
 * A declared snake_case key is never rewritten, since it matches first.
 */
function schemaKeyFor(clean: string, properties: Schema): string | null {
  if (Object.hasOwn(properties, clean)) return clean;
  const camel = snakeToCamel(clean);
  return camel !== null && Object.hasOwn(properties, camel) ? camel : null;
}

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/**
 * `timeout_ms` → `timeoutMs`; `null` for anything that is not plain
 * lower snake_case (`__path`, `Timeout_MS`, `path` stay as they are).
 */
export function snakeToCamel(key: string): string | null {
  if (!SNAKE_CASE.test(key)) return null;
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The identifier a mangled key was meant to be, or null when there is none. */
export function normalizeKey(key: string): string | null {
  let clean = key.trim();
  // A fused fragment ends with the real key after the last comma.
  const comma = clean.lastIndexOf(",");
  if (comma !== -1) clean = clean.slice(comma + 1).trim();
  // Markup that leaked in from the prompt.
  clean = clean.replace(/<[^<>]*>/g, "").trim();
  // Quotes of the model's own JSON, one level or several, escaped or not.
  clean = clean.replace(/^(?:\\?["'`])+|(?:\\?["'`])+$/g, "").trim();
  return IDENTIFIER.test(clean) ? clean : null;
}

/**
 * Returns the unwrapped value, or `undefined` when the string must be
 * left exactly as it is.
 *
 * The guard that matters is the first one. `browser.scroll`'s `amount`
 * is declared `anyOf: ["page" | "half", number]`, so the field accepts
 * both strings and numbers: `"page"` validates as written and must stay
 * a string, while `"3000"` does not and becomes `3000`. Checking the
 * concrete value against the schema — rather than asking whether the
 * schema mentions `string` anywhere — gets both halves right, and it
 * covers `os.http.request`'s `body` (`string | object`) too, where a
 * JSON-looking string is a legitimate value rather than an encoding
 * mistake.
 */
function tryCoerce(value: string, schema: Schema): unknown {
  try {
    if (validateJsonSchemaValue(value, schema)) return undefined;
    const candidate = coerceJsonSchemaValue(value, schema);
    // A coercion that yields another string changed nothing worth
    // rewriting; treat it as a no-op.
    return typeof candidate === "string" ? undefined : candidate;
  } catch {
    // Unsupported schema, or the value does not fit the declared shape.
    return undefined;
  }
}

/** The `properties` map of a default tool's args schema, when registered. */
function argsProperties(name: string): Schema | null {
  const schema = getDefaultArgsJsonSchema(name);
  return schema ? asSchema(schema.properties) : null;
}

function asSchema(value: unknown): Schema | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Schema)
    : null;
}
