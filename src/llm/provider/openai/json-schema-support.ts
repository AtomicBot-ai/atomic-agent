type JsonSchema = Record<string, unknown>;

const SUPPORTED_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "array",
  "object",
  "null",
]);

const SUPPORTED_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contentEncoding",
  "contentMediaType",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "uniqueItems",
  "writeOnly",
]);

export function assertSupportedJsonSchema(schema: JsonSchema): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`unsupported schema keyword: ${key}`);
  }
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  if (types !== undefined) {
    if (!Array.isArray(types) || types.length === 0) throw new Error("invalid schema type");
    for (const type of types) {
      if (typeof type !== "string" || !SUPPORTED_TYPES.has(type)) {
        throw new Error("unsupported schema type");
      }
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || branches.length === 0) {
        throw new Error(`invalid ${keyword}`);
      }
      for (const branch of branches) assertSupportedJsonSchema(asSchema(branch));
    }
  }
  if (schema.not !== undefined) assertSupportedJsonSchema(asSchema(schema.not));
  if (schema.items !== undefined) assertSupportedJsonSchema(asSchema(schema.items));
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    assertSupportedJsonSchema(asSchema(schema.additionalProperties));
  }
  for (const container of [schema.properties, schema.$defs] as unknown[]) {
    if (container === undefined) continue;
    const entries = asSchema(container);
    for (const child of Object.values(entries)) {
      assertSupportedJsonSchema(asSchema(child));
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error("invalid enum");
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new Error("invalid required");
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error("invalid pattern");
    new RegExp(schema.pattern, "u");
  }
  for (const keyword of [
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "multipleOf",
  ] as const) {
    const assertion = schema[keyword];
    if (assertion !== undefined && (typeof assertion !== "number" || !Number.isFinite(assertion))) {
      throw new Error(`invalid ${keyword}`);
    }
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
    throw new Error("invalid multipleOf");
  }
}

function asSchema(value: unknown): JsonSchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid schema");
  }
  return value as JsonSchema;
}
