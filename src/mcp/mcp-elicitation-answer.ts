/**
 * Check a person's accepted elicitation answer against the form fields
 * parsed by mcp-elicitation-schema.ts.
 *
 * A reason names the field, never its value: a server may ask for
 * something secret, and reasons end up in logs.
 */

import {
  fail,
  isFiniteNumber,
  isRecord,
  isStringList,
  type McpElicitationField,
  type McpElicitationValue,
  type ParseResult,
} from "./mcp-elicitation-schema.js";

/**
 * Check an accepted answer against the parsed fields. Unknown keys,
 * missing required fields and out-of-range values are refused; the
 * reason names the field, never its value.
 */
export function validateElicitationAnswer(
  fields: readonly McpElicitationField[],
  content: unknown,
): ParseResult<Record<string, McpElicitationValue>> {
  if (!isRecord(content)) return fail("answer is not an object");
  const byName = new Map(fields.map((f) => [f.name, f]));
  for (const key of Object.keys(content)) {
    if (!byName.has(key)) return fail(`answer has an unknown field ${key}`);
  }
  const out: Record<string, McpElicitationValue> = {};
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) return fail(`required field ${field.name} is missing`);
      continue;
    }
    if (!valueFits(field, value)) return fail(`field ${field.name} does not fit its schema`);
    out[field.name] = value as McpElicitationValue;
  }
  return { ok: true, value: out };
}

function valueFits(field: McpElicitationField, value: unknown): boolean {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return (
        isFiniteNumber(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (field.minimum === undefined || value >= field.minimum) &&
        (field.maximum === undefined || value <= field.maximum)
      );
    case "enum":
      return typeof value === "string" && field.options.some((o) => o.value === value);
    case "multi_enum":
      return (
        isStringList(value) &&
        new Set(value).size === value.length &&
        value.every((v) => field.options.some((o) => o.value === v)) &&
        (field.minItems === undefined || value.length >= field.minItems) &&
        (field.maxItems === undefined || value.length <= field.maxItems)
      );
    case "string": {
      if (typeof value !== "string") return false;
      const length = Array.from(value).length;
      if (field.minLength !== undefined && length < field.minLength) return false;
      if (field.maxLength !== undefined && length > field.maxLength) return false;
      return field.format === undefined || formatFits(field.format, value);
    }
  }
}

function formatFits(format: "email" | "uri" | "date" | "date-time", value: string): boolean {
  switch (format) {
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    case "date-time":
      return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
  }
}
