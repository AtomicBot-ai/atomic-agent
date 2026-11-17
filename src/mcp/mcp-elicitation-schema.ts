/**
 * MCP elicitation form schema: parse a server's `requestedSchema` into
 * neutral form fields, and check a person's answer against them.
 *
 * The MCP spec limits a form to a flat object of primitive fields
 * (string, number / integer, boolean, single-select enum, multi-select
 * enum). Anything else — a nested object, an array of free strings, an
 * unknown string format — is refused here, so a surface only ever has
 * to render the shapes listed in `McpElicitationField`.
 *
 * The answer side lives in mcp-elicitation-answer.ts.
 */

export type McpElicitationValue = string | number | boolean | string[];

export interface McpElicitationOption {
  value: string;
  label: string;
}

interface FieldBase {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
  /**
   * The field's name or title looks like a credential (password, token,
   * API key, PIN, ...). A surface should mask the input, and nothing may
   * echo the value. The spec forbids servers to ask for secrets through
   * a form; this flag is how we behave when one does anyway.
   */
  sensitive: boolean;
}

export type McpElicitationField =
  | (FieldBase & {
      kind: "string";
      minLength?: number;
      maxLength?: number;
      format?: "email" | "uri" | "date" | "date-time";
      default?: string;
    })
  | (FieldBase & {
      kind: "number";
      integer: boolean;
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (FieldBase & { kind: "boolean"; default?: boolean })
  | (FieldBase & {
      kind: "enum";
      options: McpElicitationOption[];
      default?: string;
    })
  | (FieldBase & {
      kind: "multi_enum";
      options: McpElicitationOption[];
      minItems?: number;
      maxItems?: number;
      default?: string[];
    });

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** A form, not a questionnaire: more fields than this is refused. */
export const MAX_ELICITATION_FIELDS = 20;
const MAX_FIELD_NAME_LENGTH = 64;
const STRING_FORMATS = new Set(["email", "uri", "date", "date-time"]);
const SENSITIVE_RE =
  /(password|passwd|passphrase|secret|token|api[\s_-]?key|private[\s_-]?key|credential|\bpin\b|\botp\b|\bcvv\b)/i;

/** Parse `requestedSchema` into form fields, or say why it is not a valid form. */
export function parseElicitationSchema(
  schema: unknown,
): ParseResult<McpElicitationField[]> {
  if (!isRecord(schema) || schema.type !== "object") {
    return fail("requestedSchema must be an object schema");
  }
  const properties = schema.properties;
  if (!isRecord(properties)) return fail("requestedSchema.properties missing");
  const names = Object.keys(properties);
  if (names.length > MAX_ELICITATION_FIELDS) {
    return fail(`more than ${MAX_ELICITATION_FIELDS} fields`);
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || !required.every((r) => typeof r === "string")) {
    return fail("requestedSchema.required must be a list of field names");
  }
  for (const r of required as string[]) {
    if (!names.includes(r)) return fail("required names a field that does not exist");
  }
  const fields: McpElicitationField[] = [];
  for (const name of names) {
    if (name.length === 0 || name.length > MAX_FIELD_NAME_LENGTH) {
      return fail("field name empty or too long");
    }
    const field = parseField(name, properties[name], required.includes(name));
    if (!field.ok) return field;
    fields.push(field.value);
  }
  return { ok: true, value: fields };
}

function parseField(
  name: string,
  raw: unknown,
  required: boolean,
): ParseResult<McpElicitationField> {
  if (!isRecord(raw)) return fail(`field ${name} is not a schema`);
  const title = optString(raw.title);
  const base: FieldBase = {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(optString(raw.description) !== undefined
      ? { description: optString(raw.description)! }
      : {}),
    required,
    sensitive: SENSITIVE_RE.test(name) || (title !== undefined && SENSITIVE_RE.test(title)),
  };
  switch (raw.type) {
    case "boolean":
      return ok({ ...base, kind: "boolean", ...pick(raw, "default", isBoolean) });
    case "number":
    case "integer":
      return ok({
        ...base,
        kind: "number",
        integer: raw.type === "integer",
        ...pick(raw, "minimum", isFiniteNumber),
        ...pick(raw, "maximum", isFiniteNumber),
        ...pick(raw, "default", isFiniteNumber),
      });
    case "string": {
      const options = enumOptions(raw);
      if (options === null) return fail(`field ${name} has a malformed enum`);
      if (options !== undefined) {
        return ok({ ...base, kind: "enum", options, ...pick(raw, "default", isString) });
      }
      if (raw.format !== undefined && !STRING_FORMATS.has(raw.format as string)) {
        return fail(`field ${name} has an unsupported string format`);
      }
      return ok({
        ...base,
        kind: "string",
        ...pick(raw, "minLength", isCount),
        ...pick(raw, "maxLength", isCount),
        ...(raw.format !== undefined
          ? { format: raw.format as "email" | "uri" | "date" | "date-time" }
          : {}),
        ...pick(raw, "default", isString),
      });
    }
    case "array": {
      const items = raw.items;
      const options = isRecord(items) ? enumOptions(items) : null;
      if (!options) return fail(`field ${name} is an array that is not a multi-select`);
      return ok({
        ...base,
        kind: "multi_enum",
        options,
        ...pick(raw, "minItems", isCount),
        ...pick(raw, "maxItems", isCount),
        ...pick(raw, "default", isStringList),
      });
    }
    default:
      return fail(`field ${name} has an unsupported type`);
  }
}

/**
 * `undefined` when the schema has no enum at all, `null` when it has a
 * broken one. Reads `enum` (+ legacy `enumNames`), `oneOf` and `anyOf`
 * of `{ const, title }`.
 */
function enumOptions(raw: Record<string, unknown>): McpElicitationOption[] | null | undefined {
  if (raw.enum !== undefined) {
    if (!isStringList(raw.enum) || raw.enum.length === 0) return null;
    const labels = raw.enumNames;
    if (labels !== undefined && (!isStringList(labels) || labels.length !== raw.enum.length)) {
      return null;
    }
    return raw.enum.map((value, i) => ({ value, label: (labels as string[] | undefined)?.[i] ?? value }));
  }
  const list = raw.oneOf ?? raw.anyOf;
  if (list === undefined) return undefined;
  if (!Array.isArray(list) || list.length === 0) return null;
  const options: McpElicitationOption[] = [];
  for (const o of list) {
    if (!isRecord(o) || typeof o.const !== "string") return null;
    options.push({ value: o.const, label: typeof o.title === "string" ? o.title : o.const });
  }
  return options;
}

function pick<K extends string, V>(
  raw: Record<string, unknown>,
  key: K,
  guard: (v: unknown) => v is V,
): Partial<Record<K, V>> {
  const v = raw[key];
  return guard(v) ? ({ [key]: v } as Record<K, V>) : {};
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCount(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

export function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
