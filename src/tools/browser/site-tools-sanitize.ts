/**
 * Checks on what a page says about its own WebMCP tools (ATO-521). The
 * page wrote all of it, so nothing is taken on trust: names must look
 * like names, descriptions and schemas are capped, at most
 * `maxTools` reach the model, and the model's arguments are checked
 * against the declared schema before anything runs in the page.
 *
 * The schema check is deliberately small (no new dependency): required
 * keys, the JSON type of each declared top-level property, and
 * `additionalProperties: false`. The site's own code validates the rest;
 * this only catches a wrong call before it costs an approval prompt.
 */

export const SITE_TOOL_LIMITS = {
  /** Tools shown to the model; more are listed as skipped. */
  maxTools: 32,
  /** Tools read from the page at all. */
  maxScan: 64,
  /** JSON of one tool's input schema. */
  maxSchemaChars: 8_000,
  maxDescriptionChars: 1_000,
  maxTitleChars: 120,
  /** JSON of the arguments the model passes. */
  maxArgsChars: 16_000,
  /** Text of one tool's answer. */
  maxResultChars: 20_000,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 120_000,
} as const;

/** A tool name the agent will pass back: no spaces, quotes or control characters. */
export const SITE_TOOL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

export interface SiteTool {
  name: string;
  title: string;
  description: string;
  /** Parsed input schema, or `null` when the tool declared none. */
  inputSchema: Record<string, unknown> | null;
  /** The site says the tool only reads. Shown, never trusted: every call still asks. */
  readOnlyHint: boolean;
}

export type SiteToolSkipReason =
  | "bad_name"
  | "duplicate_name"
  | "schema_too_large"
  | "schema_not_json"
  | "schema_not_object"
  | "too_many";

export interface SiteToolListing {
  tools: SiteTool[];
  skipped: Array<{ name: string; reason: SiteToolSkipReason }>;
  /** How many tools the page declared, before any limit. */
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** Collapse whitespace and drop control characters from site text. */
function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim();
}

/** A skipped tool's name, safe to print even when it is not a valid name. */
function shownName(value: unknown): string {
  const text = cleanText(value);
  return text.length === 0 ? "(no name)" : JSON.stringify(clip(text, 64));
}

/**
 * The tools a page declared, checked and capped. `raw` is what
 * `BrowserBackend.listSiteTools` returned; `total` is the page's own count.
 */
export function sanitizeSiteTools(
  raw: readonly unknown[],
  total: number = raw.length,
  limits: typeof SITE_TOOL_LIMITS = SITE_TOOL_LIMITS,
): SiteToolListing {
  const tools: SiteTool[] = [];
  const skipped: SiteToolListing["skipped"] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!SITE_TOOL_NAME_PATTERN.test(name)) {
      skipped.push({ name: shownName(entry.name), reason: "bad_name" });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "duplicate_name" });
      continue;
    }
    seen.add(name);
    let inputSchema: Record<string, unknown> | null = null;
    if (typeof entry.inputSchema === "string") {
      if (entry.inputSchema.length > limits.maxSchemaChars) {
        skipped.push({ name, reason: "schema_too_large" });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.inputSchema);
      } catch {
        skipped.push({ name, reason: "schema_not_json" });
        continue;
      }
      if (!isRecord(parsed)) {
        skipped.push({ name, reason: "schema_not_object" });
        continue;
      }
      inputSchema = parsed;
    }
    if (tools.length >= limits.maxTools) {
      skipped.push({ name, reason: "too_many" });
      continue;
    }
    tools.push({
      name,
      title: clip(cleanText(entry.title), limits.maxTitleChars),
      description: clip(cleanText(entry.description), limits.maxDescriptionChars),
      inputSchema,
      readOnlyHint: entry.readOnlyHint === true,
    });
  }
  return { tools, skipped, total: Math.max(total, raw.length) };
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  // An integer is a number too.
  return expected === "number" && actual === "integer";
}

/**
 * Problems with `args` for a tool declaring `schema`, or an empty list.
 * Only what the schema states at its top level is checked.
 */
export function checkSiteToolArgs(
  schema: Record<string, unknown> | null,
  args: Record<string, unknown>,
): string[] {
  if (schema === null) return [];
  if (schema.type !== undefined && schema.type !== "object") {
    return [`the tool's schema expects ${String(schema.type)}, not an object of named arguments`];
  }
  const problems: string[] = [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in args)) problems.push(`missing required \`${key}\``);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const declared = properties[key];
    if (declared === undefined) {
      if (schema.additionalProperties === false) problems.push(`\`${key}\` is not an argument of this tool`);
      continue;
    }
    if (!isRecord(declared)) continue;
    const expected = declared.type;
    const actual = jsonTypeOf(value);
    const allowed = Array.isArray(expected)
      ? expected.filter((item): item is string => typeof item === "string")
      : typeof expected === "string"
        ? [expected]
        : [];
    if (allowed.length > 0 && !allowed.some((type) => typeMatches(type, actual))) {
      problems.push(`\`${key}\` should be ${allowed.join(" or ")}, got ${actual}`);
    }
    if (Array.isArray(declared.enum) && !declared.enum.some((option) => option === value)) {
      problems.push(`\`${key}\` must be one of ${JSON.stringify(declared.enum).slice(0, 200)}`);
    }
  }
  return problems;
}
