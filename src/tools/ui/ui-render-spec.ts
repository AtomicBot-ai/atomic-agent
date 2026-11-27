/**
 * The spec a `ui.render` call draws (ATO-2457): a ready component, not a
 * page. The desktop draws it with its own DOM (no iframe, no script of the
 * model's); a terminal shows `uiSpecText` (ui-render-text.ts). Parsing is
 * strict about shape and caps every string and list, so a host can draw
 * what it gets without checking it again.
 *
 *   decision  a question with 2..8 buttons; a click puts the option's
 *             `message` (or its label) in the person's message box
 *   form      1..12 fields and one submit button; the filled values go in
 *             the box as "Label: value" lines
 *   cards     1..12 cards (title, text, meta line), each with an optional
 *             action button that puts its `message` in the box
 */

export const UI_KINDS = ["decision", "form", "cards"] as const;
export type UiKind = (typeof UI_KINDS)[number];

export const UI_FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox", "date"] as const;
export type UiFieldType = (typeof UI_FIELD_TYPES)[number];

export interface UiOption { label: string; description?: string; message?: string }
export interface UiField {
  name: string;
  label: string;
  type: UiFieldType;
  /** For `select`: the choices, 1..20. */
  options?: string[];
  placeholder?: string;
  required?: boolean;
  /** The value the field starts with (a string; "true"/"false" for a checkbox). */
  value?: string;
}
export interface UiCard { title: string; text?: string; meta?: string; action?: { label: string; message: string } }

export interface UiSpec {
  kind: UiKind;
  title: string;
  text?: string;
  options?: UiOption[];
  fields?: UiField[];
  /** The form's button label. */
  submit?: string;
  cards?: UiCard[];
}

export const UI_LIMITS = {
  title: 200, text: 2_000, label: 120, description: 300, message: 2_000, placeholder: 120, value: 2_000,
  options: { min: 2, max: 8 }, fields: { min: 1, max: 12 }, selectOptions: { min: 1, max: 20 }, cards: { min: 1, max: 12 },
} as const;

function str(raw: unknown, where: string, max: number, required: true): string;
function str(raw: unknown, where: string, max: number, required?: false): string | undefined;
function str(raw: unknown, where: string, max: number, required = false): string | undefined {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new Error(`\`${where}\` must be a non-empty string`);
    return undefined;
  }
  // Small models send numbers and booleans where a label is asked for.
  const value = typeof raw === "string" ? raw.trim() : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
  if (value === null) throw new Error(`\`${where}\` must be a string`);
  if (value.length === 0) {
    if (required) throw new Error(`\`${where}\` must be a non-empty string`);
    return undefined;
  }
  if (value.length > max) throw new Error(`\`${where}\` is longer than ${max} characters`);
  return value;
}

function list(raw: unknown, where: string, bounds: { min: number; max: number }): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`\`${where}\` must be an array`);
  if (raw.length < bounds.min) throw new Error(`\`${where}\` needs at least ${bounds.min} item${bounds.min === 1 ? "" : "s"}`);
  if (raw.length > bounds.max) throw new Error(`\`${where}\` has ${raw.length} items; at most ${bounds.max}`);
  return raw;
}

function record(raw: unknown, where: string): Record<string, unknown> {
  // A bare string is the label, the shape a small model reaches for first.
  if (typeof raw === "string") return { label: raw, title: raw };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`\`${where}\` must be an object`);
  return raw as Record<string, unknown>;
}

function parseOptions(raw: unknown): UiOption[] {
  const seen = new Set<string>();
  return list(raw, "options", UI_LIMITS.options).map((item, i) => {
    const r = record(item, `options[${i}]`);
    const label = str(r.label, `options[${i}].label`, UI_LIMITS.label, true);
    if (seen.has(label.toLowerCase())) throw new Error(`two options are labelled "${label}"; give each its own label`);
    seen.add(label.toLowerCase());
    const description = str(r.description, `options[${i}].description`, UI_LIMITS.description);
    const message = str(r.message, `options[${i}].message`, UI_LIMITS.message);
    return { label, ...(description ? { description } : {}), ...(message ? { message } : {}) };
  });
}

/** `email-address` from "E-mail address": the key a form value is sent under when no name is given. */
function fieldName(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug.length > 0 ? slug : "field";
}

function parseFields(raw: unknown): UiField[] {
  const names = new Set<string>();
  return list(raw, "fields", UI_LIMITS.fields).map((item, i) => {
    const r = record(item, `fields[${i}]`);
    const label = str(r.label, `fields[${i}].label`, UI_LIMITS.label, true);
    const rawType = str(r.type, `fields[${i}].type`, 20)?.toLowerCase() ?? (Array.isArray(r.options) ? "select" : "text");
    if (!(UI_FIELD_TYPES as readonly string[]).includes(rawType)) {
      throw new Error(`fields[${i}].type "${rawType}" is not supported; use one of ${UI_FIELD_TYPES.join(", ")}`);
    }
    const type = rawType as UiFieldType;
    let name = str(r.name, `fields[${i}].name`, 40) ?? fieldName(label);
    for (let n = 2; names.has(name); n++) name = `${fieldName(label)}-${n}`;
    names.add(name);
    const field: UiField = { name, label, type };
    if (type === "select") {
      field.options = list(r.options, `fields[${i}].options`, UI_LIMITS.selectOptions)
        .map((o, j) => str(o, `fields[${i}].options[${j}]`, UI_LIMITS.label, true));
    }
    const placeholder = str(r.placeholder, `fields[${i}].placeholder`, UI_LIMITS.placeholder);
    if (placeholder && type !== "checkbox" && type !== "select") field.placeholder = placeholder;
    if (r.required === true) field.required = true;
    const value = str(r.value ?? r.default, `fields[${i}].value`, UI_LIMITS.value);
    if (value !== undefined) {
      if (type === "select" && !field.options!.includes(value)) throw new Error(`fields[${i}].value "${value}" is not one of its options`);
      field.value = type === "checkbox" ? String(value === "true") : value;
    }
    return field;
  });
}

function parseCards(raw: unknown): UiCard[] {
  return list(raw, "cards", UI_LIMITS.cards).map((item, i) => {
    const r = record(item, `cards[${i}]`);
    const title = str(r.title, `cards[${i}].title`, UI_LIMITS.label, true);
    const text = str(r.text, `cards[${i}].text`, UI_LIMITS.text);
    const meta = str(r.meta, `cards[${i}].meta`, UI_LIMITS.label);
    const card: UiCard = { title, ...(text ? { text } : {}), ...(meta ? { meta } : {}) };
    if (r.action !== undefined && r.action !== null) {
      const a = record(r.action, `cards[${i}].action`);
      const label = str(a.label, `cards[${i}].action.label`, UI_LIMITS.label, true);
      const message = str(a.message, `cards[${i}].action.message`, UI_LIMITS.message) ?? `${label}: ${title}`;
      card.action = { label, message };
    }
    return card;
  });
}

/** The spec a call's args describe, checked and capped. Throws an Error whose message the model can act on. */
export function parseUiSpec(raw: Record<string, unknown>): UiSpec {
  const kind = str(raw.kind, "kind", 20)?.toLowerCase()
    ?? (raw.fields !== undefined ? "form" : raw.cards !== undefined ? "cards" : raw.options !== undefined ? "decision" : undefined);
  if (kind === undefined || !(UI_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`\`kind\` must be one of ${UI_KINDS.join(", ")}`);
  }
  const title = str(raw.title, "title", UI_LIMITS.title, true);
  const text = str(raw.text, "text", UI_LIMITS.text);
  const base = { kind: kind as UiKind, title, ...(text ? { text } : {}) };
  if (kind === "decision") return { ...base, options: parseOptions(raw.options) };
  if (kind === "form") {
    const submit = str(raw.submit, "submit", UI_LIMITS.label);
    return { ...base, fields: parseFields(raw.fields), ...(submit ? { submit } : {}) };
  }
  return { ...base, cards: parseCards(raw.cards) };
}
