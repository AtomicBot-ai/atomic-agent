import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * A recipe (ATO-1070, recipe v1 decided in ATO-1615): a shareable task. It is
 * a title, an optional description, the task text with `{{key}}`
 * placeholders, and up to 16 parameters. Opening one puts the filled text into
 * a new chat's box; the person reads it and sends it. A recipe never picks the
 * model, tools, MCP servers, skills or permissions: those keys are refused by
 * name, so a shared file cannot quietly widen what the agent may do.
 *
 *   version: 1
 *   title: Weekly report
 *   description: Sums up a folder of notes
 *   prompt: |
 *     Summarise the notes in {{folder}} for {{who}}.
 *   params:
 *     - key: folder
 *       default: ~/Notes
 *     - key: who
 *       description: Who reads the summary
 *
 * The limits and placeholder rules are the desktop link route's
 * (desktop/main/deeplink.ts, `recipeOpenRoute`), so a file that parses here
 * makes a link the app opens. Placeholders are written `{{key}}` with spaces
 * allowed inside, as Goose recipes write them.
 */

export const RECIPE_VERSION = 1;
export const RECIPE_MAX_PARAMS = 16;
export const RECIPE_TITLE_MAX = 120;
export const RECIPE_DESCRIPTION_MAX = 300;
/** The link route's cap on its one multi-line value (DEEPLINK_MAX_TEXT). */
export const RECIPE_PROMPT_MAX = 6000;
export const RECIPE_PARAM_DEFAULT_MAX = 500;
/** File only: the link has no room for a per-parameter description. */
export const RECIPE_PARAM_DESCRIPTION_MAX = 200;
/** A whole recipe file. The fields' own caps add up to far less. */
export const RECIPE_FILE_MAX_BYTES = 32 * 1024;
export const RECIPE_PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** `{{ key }}`: the placeholder shape Goose recipes use. */
export const RECIPE_PLACEHOLDER_RE = /\{\{\s*([^{}\s]*)\s*\}\}/g;

/**
 * Keys a recipe may not carry (v1 decision): each would let a shared recipe
 * choose what the agent can do. The link route refuses the same names.
 */
export const RECIPE_REFUSED_KEYS: readonly string[] = [
  "model", "provider", "tools", "tool", "mcp", "server", "servers",
  "skill", "skills", "permission", "permissions", "approval", "approve",
  "autosend", "send", "run", "extension", "extensions", "settings",
];

// Single-line fields travel as plain link values, which refuse every control character.
// eslint-disable-next-line no-control-regex
const LINE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
// The text may hold tab and line breaks, nothing else below space.
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const TOP_KEYS = new Set(["version", "title", "name", "description", "prompt", "params"]);
const PARAM_KEYS = new Set(["key", "default", "description"]);

export interface RecipeParam {
  key: string;
  /** Prefilled in the field; absent means the field starts empty. */
  default?: string;
  /** A hint under the field. Kept in files only: a link drops it. */
  description?: string;
}

export interface Recipe {
  version: 1;
  title: string;
  description?: string;
  prompt: string;
  params: RecipeParam[];
}

export type RecipeParseResult = { ok: true; recipe: Recipe } | { ok: false; error: string };

/**
 * A recipe file (YAML, or JSON when it starts with `{`) into a checked
 * recipe. Never throws: a broken file is an error message for the person.
 */
export function parseRecipe(text: string): RecipeParseResult {
  if (typeof text !== "string") return { ok: false, error: "The recipe is not text." };
  if (Buffer.byteLength(text) > RECIPE_FILE_MAX_BYTES) {
    return { ok: false, error: `The recipe file is larger than ${RECIPE_FILE_MAX_BYTES / 1024} KiB.` };
  }
  const body = text.replace(/^﻿/, "");
  if (!body.trim()) return { ok: false, error: "The recipe file is empty." };
  let data: unknown;
  try {
    data = body.trimStart().startsWith("{") ? JSON.parse(body) : parseYaml(body);
  } catch (err) {
    return { ok: false, error: `The recipe is not valid YAML or JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "A recipe is a mapping of keys (version, title, description, prompt, params)." };
  }
  return recipeFromObject(data as Record<string, unknown>);
}

/** The shared checks for a file's object and a link's values. */
export function recipeFromObject(data: Record<string, unknown>): RecipeParseResult {
  const keys = Object.keys(data);
  const refused = keys.find((k) => RECIPE_REFUSED_KEYS.includes(k.toLowerCase()));
  if (refused !== undefined) {
    return { ok: false, error: `A recipe cannot choose the model, tools, servers, skills or permissions ("${refused}"). Only its text and parameters are used.` };
  }
  const unknown = keys.find((k) => !TOP_KEYS.has(k));
  if (unknown !== undefined) {
    return { ok: false, error: `The recipe has a key Atomic Agent does not read ("${unknown.slice(0, 40)}"). Recipe keys are version, title, description, prompt and params.` };
  }
  if (data.version !== undefined && data.version !== RECIPE_VERSION) {
    return { ok: false, error: `This app reads recipe version ${RECIPE_VERSION}; the file says ${JSON.stringify(data.version)}.` };
  }
  if (data.title !== undefined && data.name !== undefined) return { ok: false, error: "The recipe gives both a title and a name; give one." };
  const title = optionalText(data.title ?? data.name, "title");
  if (!title.ok) return title;
  if (!title.value) return { ok: false, error: "The recipe has no title." };
  if (title.value.length > RECIPE_TITLE_MAX) return { ok: false, error: `The recipe title is longer than ${RECIPE_TITLE_MAX} characters.` };
  if (LINE_CONTROL_RE.test(title.value)) return { ok: false, error: "The recipe title must be one line without control characters." };
  const description = optionalText(data.description, "description");
  if (!description.ok) return description;
  if (description.value.length > RECIPE_DESCRIPTION_MAX) return { ok: false, error: `The recipe description is longer than ${RECIPE_DESCRIPTION_MAX} characters.` };
  if (LINE_CONTROL_RE.test(description.value)) return { ok: false, error: "The recipe description must be one line without control characters." };
  if (typeof data.prompt !== "string" || !data.prompt.trim()) return { ok: false, error: "The recipe has no prompt (the task text)." };
  const prompt = data.prompt.replace(/\r\n?/g, "\n").trim();
  if (prompt.length > RECIPE_PROMPT_MAX) return { ok: false, error: `The recipe prompt is longer than ${RECIPE_PROMPT_MAX} characters.` };
  if (TEXT_CONTROL_RE.test(prompt)) return { ok: false, error: "The recipe prompt holds control characters." };
  const params = readParams(data.params);
  if (!params.ok) return params;
  const used = recipePlaceholders(prompt);
  const undeclared = used.find((k) => !params.value.some((p) => p.key === k));
  if (undeclared !== undefined) {
    return { ok: false, error: `The recipe prompt uses {{${undeclared.slice(0, 40)}}}, but params does not declare it.` };
  }
  const unused = params.value.find((p) => !used.includes(p.key));
  if (unused) return { ok: false, error: `The parameter ${unused.key} is not used in the recipe prompt.` };
  return {
    ok: true,
    recipe: {
      version: RECIPE_VERSION,
      title: title.value,
      ...(description.value ? { description: description.value } : {}),
      prompt,
      params: params.value,
    },
  };
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function optionalText(value: unknown, what: string): Checked<string> {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: `The recipe ${what} must be text.` };
  return { ok: true, value: value.trim() };
}

function readParams(raw: unknown): Checked<RecipeParam[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "params must be a list of { key, default, description }." };
  if (raw.length > RECIPE_MAX_PARAMS) return { ok: false, error: `A recipe takes at most ${RECIPE_MAX_PARAMS} params.` };
  const out: RecipeParam[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "Each param is a mapping with a key (and an optional default and description)." };
    }
    const entry = item as Record<string, unknown>;
    const odd = Object.keys(entry).find((k) => !PARAM_KEYS.has(k));
    if (odd !== undefined) return { ok: false, error: `A param has a key Atomic Agent does not read ("${odd.slice(0, 40)}"); use key, default and description.` };
    const key = typeof entry.key === "string" ? entry.key.trim() : "";
    if (!RECIPE_PARAM_KEY_RE.test(key)) {
      return { ok: false, error: `The parameter name ${JSON.stringify(String(entry.key ?? "").slice(0, 40))} can use lowercase letters, digits and _ (up to 32, starting with a letter).` };
    }
    if (out.some((p) => p.key === key)) return { ok: false, error: `The parameter ${key} is given twice.` };
    const param: RecipeParam = { key };
    if (entry.default !== undefined && entry.default !== null) {
      // YAML reads `default: 5` as a number; a field holds text either way.
      const def = typeof entry.default === "number" || typeof entry.default === "boolean" ? String(entry.default) : entry.default;
      if (typeof def !== "string") return { ok: false, error: `The default for ${key} must be text.` };
      if (def.length > RECIPE_PARAM_DEFAULT_MAX) return { ok: false, error: `The default for ${key} is longer than ${RECIPE_PARAM_DEFAULT_MAX} characters.` };
      if (LINE_CONTROL_RE.test(def)) return { ok: false, error: `The default for ${key} must be one line without control characters.` };
      if (def !== "") param.default = def;
    }
    const hint = optionalText(entry.description, `description of ${key}`);
    if (!hint.ok) return hint;
    if (hint.value.length > RECIPE_PARAM_DESCRIPTION_MAX) return { ok: false, error: `The description of ${key} is longer than ${RECIPE_PARAM_DESCRIPTION_MAX} characters.` };
    if (LINE_CONTROL_RE.test(hint.value)) return { ok: false, error: `The description of ${key} must be one line without control characters.` };
    if (hint.value) param.description = hint.value;
    out.push(param);
  }
  return { ok: true, value: out };
}

/** The placeholders a recipe's text uses, each once, in order. */
export function recipePlaceholders(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(RECIPE_PLACEHOLDER_RE)) {
    const key = m[1] ?? "";
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The text with each `{{key}}` replaced by the person's value, else the
 * param's default; a placeholder with neither stays as written. One pass and
 * plain text only: a `{{x}}` inside a value is not expanded, and nothing is
 * run. The person still reads the result and sends it themselves.
 */
export function renderRecipePrompt(recipe: Recipe, values: Readonly<Record<string, string>> = {}): string {
  return recipe.prompt.replace(RECIPE_PLACEHOLDER_RE, (whole, key: string) => {
    if (Object.prototype.hasOwnProperty.call(values, key) && typeof values[key] === "string") return values[key]!;
    const def = recipe.params.find((p) => p.key === key)?.default;
    return def ?? whole;
  });
}

/** The recipe as the YAML file `parseRecipe` reads back. */
export function recipeToYaml(recipe: Recipe): string {
  const doc: Record<string, unknown> = { version: RECIPE_VERSION, title: recipe.title };
  if (recipe.description) doc.description = recipe.description;
  doc.prompt = recipe.prompt;
  if (recipe.params.length > 0) {
    doc.params = recipe.params.map((p) => ({
      key: p.key,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.description ? { description: p.description } : {}),
    }));
  }
  // lineWidth 0: never fold long lines, so the text reads back exactly.
  return stringifyYaml(doc, { lineWidth: 0 });
}
