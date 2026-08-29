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

  let coerced: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const schema = asSchema(properties[key]);
    if (!schema) continue;

    const candidate = tryCoerce(value, schema);
    if (candidate === undefined) continue;

    coerced ??= { ...args };
    coerced[key] = candidate;
  }
  return coerced ?? args;
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
