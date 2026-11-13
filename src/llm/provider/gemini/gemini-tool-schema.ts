/**
 * Tool schemas for Google's OpenAI-compatible Gemini endpoint (ATO-1282).
 *
 * That endpoint turns `tools[].function.parameters` into Gemini's own
 * function-declaration schema, an OpenAPI subset, and answers a keyword
 * it does not know with a 400 for the whole request ("Invalid JSON
 * payload received. Unknown name \"additionalProperties\" at
 * 'tools[0].function_declarations[3].parameters' …"). MCP servers built
 * on the official SDKs send `$schema` and `additionalProperties` on every
 * tool.
 *
 * Conservative on purpose. Removed are only keywords that annotate the
 * schema or loosen nothing the model needs to fill a call: dialect and id
 * markers, `additionalProperties`, annotation-only keywords, and numeric
 * or array refinements Gemini's subset does not have. `const` becomes a
 * one-value `enum` and `oneOf` becomes `anyOf`, which keep the meaning.
 * `type`, `properties`, `required`, `items`, `enum`, `description`,
 * `anyOf`, `minimum`/`maximum`, lengths and `pattern` are kept. `$ref`,
 * `$defs`, `allOf` and `not` are left alone: dropping them would change
 * what the tool accepts, and whether the endpoint resolves them is not
 * proven.
 *
 * A tool whose schema needs no change is returned as the same object, so
 * a request without such keywords goes out byte-identical.
 */

type Json = Record<string, unknown>;

/** Keywords dropped wherever they appear as a schema keyword. */
const DROPPED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "additionalProperties",
  "examples",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentEncoding",
  "contentMediaType",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
]);

/** The only string formats Gemini's schema accepts. */
const GEMINI_STRING_FORMATS = new Set(["enum", "date-time"]);

/** Keywords whose value is one subschema. */
const SINGLE_SUBSCHEMA = ["items", "not"] as const;
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST = ["anyOf", "oneOf", "allOf", "prefixItems", "items"] as const;
/** Keywords whose value maps names to subschemas. */
const SUBSCHEMA_MAP = ["properties", "$defs", "definitions"] as const;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringTyped(schema: Json): boolean {
  const type = schema.type;
  return type === "string" || (Array.isArray(type) && type.includes("string"));
}

/** One schema, cleaned; the same object when nothing changed. */
export function toGeminiToolSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  let changed = false;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) {
      changed = true;
      continue;
    }
    if (key === "format" && isStringTyped(schema) && typeof value === "string" && !GEMINI_STRING_FORMATS.has(value)) {
      changed = true;
      continue;
    }
    out[key] = value;
  }
  if ("const" in out) {
    if (!("enum" in out)) out.enum = [out.const];
    delete out.const;
    changed = true;
  }
  // A schema that has both keeps its `oneOf`: merging the two would
  // change what it accepts.
  if (Array.isArray(out.oneOf) && !("anyOf" in out)) {
    out.anyOf = out.oneOf;
    delete out.oneOf;
    changed = true;
  }
  for (const key of SINGLE_SUBSCHEMA) {
    const value = out[key];
    if (!isRecord(value)) continue;
    const next = toGeminiToolSchema(value);
    if (next !== value) {
      out[key] = next;
      changed = true;
    }
  }
  for (const key of SUBSCHEMA_LIST) {
    const value = out[key];
    if (!Array.isArray(value)) continue;
    const next = value.map((item) => toGeminiToolSchema(item));
    if (next.some((item, index) => item !== value[index])) {
      out[key] = next;
      changed = true;
    }
  }
  for (const key of SUBSCHEMA_MAP) {
    const value = out[key];
    if (!isRecord(value)) continue;
    // The map's keys are names (a property may be called "$schema"),
    // never keywords: only the values are schemas.
    let mapChanged = false;
    const next: Json = {};
    for (const [name, sub] of Object.entries(value)) {
      next[name] = toGeminiToolSchema(sub);
      if (next[name] !== sub) mapChanged = true;
    }
    if (mapChanged) {
      out[key] = next;
      changed = true;
    }
  }
  return changed ? out : schema;
}

/**
 * The `tools` array of an OpenAI chat body, with each function's
 * `parameters` cleaned. The same array when no tool changed.
 */
export function toGeminiTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const next = tools.map((tool: unknown) => {
    if (!isRecord(tool) || !isRecord(tool.function)) return tool;
    const fn = tool.function;
    if (!("parameters" in fn)) return tool;
    const parameters = toGeminiToolSchema(fn.parameters);
    if (parameters === fn.parameters) return tool;
    changed = true;
    return { ...tool, function: { ...fn, parameters } };
  });
  return changed ? next : tools;
}

/**
 * The `response_format` of an OpenAI chat body, with its
 * `json_schema.schema` cleaned the same way (ATO-1444). The memory
 * helper calls (query rewriter, link generator, vote, distill) send a
 * schema there, and the strict ones carry `additionalProperties: false`,
 * which the same endpoint refuses with the same 400. Anything that is
 * not a `json_schema` envelope, and a schema that needs no change, is
 * returned as the same object.
 */
export function toGeminiResponseFormat(responseFormat: unknown): unknown {
  if (!isRecord(responseFormat) || responseFormat.type !== "json_schema") return responseFormat;
  const jsonSchema = responseFormat.json_schema;
  if (!isRecord(jsonSchema) || !("schema" in jsonSchema)) return responseFormat;
  const schema = toGeminiToolSchema(jsonSchema.schema);
  if (schema === jsonSchema.schema) return responseFormat;
  return { ...responseFormat, json_schema: { ...jsonSchema, schema } };
}
