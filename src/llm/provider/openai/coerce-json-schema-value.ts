type JsonSchema = Record<string, unknown>;

import { assertSupportedJsonSchema } from "./json-schema-support.js";

export function coerceJsonSchemaValue(value: string, schema: JsonSchema): unknown {
  assertSupportedJsonSchema(schema);
  const candidates: unknown[] = [];
  for (const type of coercionTypes(schema)) {
    try {
      const candidate = coerceByType(value, type);
      if (
        matchesSchema(candidate, schema) &&
        !candidates.some((existing) => jsonEqual(existing, candidate))
      ) {
        candidates.push(candidate);
      }
    } catch {
      // Try the next type admitted by the schema.
    }
  }
  if (candidates.length === 0) throw new Error("value does not match schema");
  return candidates[0];
}

export function validateJsonSchemaValue(value: unknown, schema: JsonSchema): boolean {
  assertSupportedJsonSchema(schema);
  return matchesSchema(value, schema);
}

function coercionTypes(schema: JsonSchema): string[] {
  const types = new Set<string>();
  collectTypes(schema, types);
  if (types.size === 0) types.add("string");
  return [...types];
}

function collectTypes(schema: JsonSchema, out: Set<string>): void {
  if (typeof schema.type === "string") out.add(schema.type);
  if (Array.isArray(schema.type)) {
    for (const type of schema.type) if (typeof type === "string") out.add(type);
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) collectTypes(asSchema(branch), out);
    }
  }
  if (out.size === 0 && Object.hasOwn(schema, "const")) {
    out.add(jsonType(schema.const));
  }
  if (out.size === 0 && Array.isArray(schema.enum)) {
    for (const entry of schema.enum) out.add(jsonType(entry));
  }
}

function coerceByType(value: string, type: string): unknown {
  switch (type) {
    case "integer": {
      if (!/^[+-]?\d+$/.test(value)) throw new Error("invalid integer");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error("invalid integer");
      return parsed;
    }
    case "number": {
      if (value.length === 0) throw new Error("invalid number");
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error("invalid number");
      return parsed;
    }
    case "boolean":
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
      throw new Error("invalid boolean");
    case "array": {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) throw new Error("invalid array");
      return parsed;
    }
    case "object": {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) throw new Error("invalid object");
      return parsed;
    }
    case "null":
      if (value.toLowerCase() !== "null") throw new Error("invalid null");
      return null;
    case "string":
      return value;
    default:
      throw new Error("unsupported schema type");
  }
}

function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && !anyOf.some((entry) => matchesSchema(value, asSchema(entry)))) {
    return false;
  }
  const oneOf = schema.oneOf;
  if (
    Array.isArray(oneOf) &&
    oneOf.filter((entry) => matchesSchema(value, asSchema(entry))).length !== 1
  ) {
    return false;
  }
  const allOf = schema.allOf;
  if (Array.isArray(allOf) && !allOf.every((entry) => matchesSchema(value, asSchema(entry)))) {
    return false;
  }
  if (isRecord(schema.not) && matchesSchema(value, schema.not)) return false;
  if (Object.hasOwn(schema, "const") && !jsonEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonEqual(value, entry))) {
    return false;
  }
  if (!matchesType(value, schema.type)) return false;

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return false;
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      return false;
    }
    if (
      typeof schema.multipleOf === "number" &&
      !isMultipleOf(value, schema.multipleOf)
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (
      schema.uniqueItems === true &&
      value.some((entry, index) => value.slice(0, index).some((prior) => jsonEqual(prior, entry)))
    ) {
      return false;
    }
    const items = isRecord(schema.items) ? schema.items : null;
    if (items && !value.every((entry) => matchesSchema(entry, items))) return false;
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    const keys = Object.keys(value);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      return false;
    }
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
      return false;
    }
    if (!required.every((name) => Object.hasOwn(value, name))) return false;
    for (const [name, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        if (!matchesSchema(entry, asSchema(properties[name]))) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (
        isRecord(schema.additionalProperties) &&
        !matchesSchema(entry, schema.additionalProperties)
      ) {
        return false;
      }
    }
  }
  return true;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === undefined) return true;
  if (Array.isArray(type)) return type.some((entry) => matchesType(value, entry));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function isMultipleOf(value: number, multiple: number): boolean {
  const quotient = value / multiple;
  return Number.isFinite(quotient) && Math.abs(quotient - Math.round(quotient)) < 1e-10;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  if (typeof value === "number" && Number.isSafeInteger(value)) return "integer";
  return typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, i) => jsonEqual(entry, right[i]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

function asSchema(value: unknown): JsonSchema {
  if (!isRecord(value)) throw new Error("invalid schema");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
