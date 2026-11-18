/*
 * ATO-1072: recipes saved on this computer ("Save as recipe…" on a chat, the
 * Recipes gallery). Recipe v1 is Nadya's decision of 17.11 (ATO-1615): a
 * title, an optional description, the task text with {{key}} placeholders
 * and up to 16 parameters (a key and an optional default). A recipe never
 * carries a model, tools, MCP servers, skills or permissions; running one
 * puts the filled text in a new chat's box and the person presses Enter.
 *
 * Kept in Electron's userData (recipes.json), written whole via a temp file,
 * like the projects (projects-store.ts). This file is pure (no electron
 * import) so the Node checks load it.
 *
 * Every saved recipe can be shared: the caps below are the ones the
 * atomicagent://recipe/open link route checks (main/deeplink.ts, ATO-1615),
 * and a recipe whose link would be refused there is refused here, so
 * "Copy link" always gives a link that opens.
 *
 * Shape (version 1):
 *   recipes: [{id, title, description, prompt, params: [{key, default?}], createdAt, updatedAt}]   newest first
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RecipeParam { key: string; default?: string }
export interface Recipe {
  id: string;
  title: string;
  description: string;
  prompt: string;
  params: RecipeParam[];
  createdAt: number;
  updatedAt: number;
}
export interface Recipes { version: 1; recipes: Recipe[] }
export type RecipesResult<T> = ({ ok: true } & T) | { ok: false; error: string };
/** What validateRecipe gives back: a recipe's content, checked and tidied. */
export type RecipeContent = Pick<Recipe, "title" | "description" | "prompt" | "params">;

export const MAX_RECIPES = 500;
/* The link route's limits (main/deeplink.ts, ATO-1615), copied, not imported: that route ships in its own PR. */
export const RECIPE_MAX_PARAMS = 16;
export const RECIPE_TITLE_MAX = 120;
export const RECIPE_DESCRIPTION_MAX = 300;
export const RECIPE_PROMPT_MAX = 6000;
export const RECIPE_PARAM_DEFAULT_MAX = 500;
/** The whole link, as the route reads it (DEEPLINK_MAX_LENGTH). */
export const RECIPE_LINK_MAX = 8192;
export const RECIPE_PARAM_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** `{{ key }}`, the placeholder shape Goose recipes use (the route's RECIPE_PLACEHOLDER_RE). */
export const RECIPE_PLACEHOLDER_RE = /\{\{\s*([^{}\s]*)\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/* The task text may span lines: tab, line feed and carriage return are allowed there. */
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/* Text that reads differently than it runs: direction overrides and invisible characters. */
const HIDDEN_RE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
/* Half of a surrogate pair: encodeURIComponent throws on it, so no link could be made. */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Fits the window's data attributes and act verbs (no colon). */
const ID_RE = /^r[a-z0-9]{6,24}$/;

export function recipesPath(dir: string): string {
  return join(dir, "recipes.json");
}

export function emptyRecipes(): Recipes {
  return { version: 1, recipes: [] };
}

export function newRecipeId(): string {
  return `r${randomBytes(8).toString("hex").slice(0, 12)}`;
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
 * The atomicagent://recipe/open link for a recipe, the exact shape the link
 * route (ATO-1615) parses: title, description (when there is one), prompt,
 * then one `param=key` or `param=key=default` per parameter. Every value is
 * percent-encoded, so `+`, `&` and `#` in the text stay text.
 */
export function recipeLink(recipe: RecipeContent): string {
  const enc = encodeURIComponent;
  let link = `atomicagent://recipe/open?title=${enc(recipe.title)}`;
  if (recipe.description) link += `&description=${enc(recipe.description)}`;
  link += `&prompt=${enc(recipe.prompt)}`;
  for (const p of recipe.params) link += `&param=${enc(p.default ? `${p.key}=${p.default}` : p.key)}`;
  return link;
}

function oneLine(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

function oddText(what: string, text: string, control: RegExp): string | null {
  if (control.test(text)) return `The ${what} holds control characters.`;
  if (HIDDEN_RE.test(text)) return `The ${what} holds invisible or direction-changing characters.`;
  if (LONE_SURROGATE_RE.test(text)) return `The ${what} holds a broken character.`;
  return null;
}

/**
 * A recipe's content checked the way the link route checks it, tidied the
 * way it tidies it (title and description on one line, the text's line ends
 * as \n, both ends trimmed). The text's placeholders and the parameters must
 * match: each {{key}} declared once, each parameter used.
 */
export function validateRecipe(input: unknown): RecipesResult<{ recipe: RecipeContent }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "recipe required" };
  const r = input as Record<string, unknown>;
  if (typeof r.title !== "string") return { ok: false, error: "The recipe needs a title." };
  const title = oneLine(r.title);
  if (!title) return { ok: false, error: "The recipe needs a title." };
  if (title.length > RECIPE_TITLE_MAX) return { ok: false, error: `The title is longer than ${RECIPE_TITLE_MAX} characters.` };
  if (r.description !== undefined && r.description !== null && typeof r.description !== "string") return { ok: false, error: "The description must be text." };
  const description = oneLine(typeof r.description === "string" ? r.description : "");
  if (description.length > RECIPE_DESCRIPTION_MAX) return { ok: false, error: `The description is longer than ${RECIPE_DESCRIPTION_MAX} characters.` };
  if (typeof r.prompt !== "string") return { ok: false, error: "The recipe needs its task text." };
  const prompt = r.prompt.replace(/\r\n?/g, "\n").trim();
  if (!prompt) return { ok: false, error: "The recipe needs its task text." };
  if (prompt.length > RECIPE_PROMPT_MAX) return { ok: false, error: `The task text is longer than ${RECIPE_PROMPT_MAX} characters.` };
  const odd = oddText("title", title, CONTROL_RE) ?? oddText("description", description, CONTROL_RE) ?? oddText("task text", prompt, TEXT_CONTROL_RE);
  if (odd) return { ok: false, error: odd };

  const rawParams = r.params === undefined || r.params === null ? [] : r.params;
  if (!Array.isArray(rawParams)) return { ok: false, error: "The parameters must be a list." };
  if (rawParams.length > RECIPE_MAX_PARAMS) return { ok: false, error: `A recipe has at most ${RECIPE_MAX_PARAMS} parameters.` };
  const params: RecipeParam[] = [];
  for (const raw of rawParams) {
    const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const key = typeof p.key === "string" ? p.key.trim() : "";
    if (!RECIPE_PARAM_KEY_RE.test(key)) {
      return { ok: false, error: `The parameter name ${JSON.stringify(key.slice(0, 40))} can use lowercase letters, digits and _ (up to 32), starting with a letter.` };
    }
    if (params.some((x) => x.key === key)) return { ok: false, error: `The parameter ${key} is given twice.` };
    if (p.default !== undefined && p.default !== null && typeof p.default !== "string") return { ok: false, error: `The default for ${key} must be text.` };
    const def = typeof p.default === "string" ? p.default : "";
    if (def.length > RECIPE_PARAM_DEFAULT_MAX) return { ok: false, error: `The default for ${key} is longer than ${RECIPE_PARAM_DEFAULT_MAX} characters.` };
    const oddDef = oddText(`default for ${key}`, def, CONTROL_RE);
    if (oddDef) return { ok: false, error: oddDef };
    params.push(def ? { key, default: def } : { key });
  }
  const used = recipePlaceholders(prompt);
  const undeclared = used.find((k) => !params.some((x) => x.key === k));
  if (undeclared !== undefined) {
    if (!RECIPE_PARAM_KEY_RE.test(undeclared)) return { ok: false, error: `The text has {{${undeclared.slice(0, 40)}}}: a parameter name can use lowercase letters, digits and _ (up to 32), starting with a letter.` };
    return { ok: false, error: `The text uses {{${undeclared}}}, but it is not a parameter.` };
  }
  const unused = params.find((x) => !used.includes(x.key));
  if (unused) return { ok: false, error: `The parameter ${unused.key} is not used in the text.` };

  const recipe: RecipeContent = { title, description, prompt, params };
  if (recipeLink(recipe).length > RECIPE_LINK_MAX) {
    return { ok: false, error: "The recipe is too long to share as a link. Shorten the text or the defaults." };
  }
  return { ok: true, recipe };
}

function stamp(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

/** Whatever was read, as a valid value: entries that would not pass validateRecipe and duplicate ids dropped. */
export function coerceRecipes(raw: unknown): Recipes {
  const out = emptyRecipes();
  if (!raw || typeof raw !== "object") return out;
  const list = (raw as { recipes?: unknown }).recipes;
  if (!Array.isArray(list)) return out;
  const ids = new Set<string>();
  for (const item of list.slice(0, MAX_RECIPES)) {
    if (!item || typeof item !== "object") continue;
    const { id, createdAt, updatedAt } = item as Record<string, unknown>;
    if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) continue;
    const v = validateRecipe(item);
    if (!v.ok) continue;
    ids.add(id);
    const created = stamp(createdAt);
    out.recipes.push({ id, ...v.recipe, createdAt: created, updatedAt: Math.max(created, stamp(updatedAt)) });
  }
  return out;
}

/** Create (no id) or replace the content of a known recipe (id). Pure: returns the next value and the saved recipe. */
export function saveRecipe(
  data: Recipes,
  input: unknown,
  now: number = Date.now(),
  makeId: () => string = newRecipeId,
): RecipesResult<{ data: Recipes; recipe: Recipe }> {
  const v = validateRecipe(input);
  if (!v.ok) return v;
  const rawId = (input as { id?: unknown }).id;
  const id = rawId === undefined || rawId === null || rawId === "" ? null : rawId;
  if (id !== null) {
    const existing = typeof id === "string" ? data.recipes.find((r) => r.id === id) : undefined;
    if (!existing) return { ok: false, error: "That recipe is no longer saved." };
    const recipe: Recipe = { ...existing, ...v.recipe, updatedAt: Math.max(now, existing.createdAt) };
    return { ok: true, recipe, data: { ...data, recipes: data.recipes.map((r) => (r.id === existing.id ? recipe : r)) } };
  }
  if (data.recipes.length >= MAX_RECIPES) return { ok: false, error: `At most ${MAX_RECIPES} recipes can be saved.` };
  let newId = makeId();
  for (let i = 0; i < 5 && (!ID_RE.test(newId) || data.recipes.some((r) => r.id === newId)); i++) newId = makeId();
  if (!ID_RE.test(newId) || data.recipes.some((r) => r.id === newId)) return { ok: false, error: "could not make a recipe id" };
  const recipe: Recipe = { id: newId, ...v.recipe, createdAt: now, updatedAt: now };
  return { ok: true, recipe, data: { ...data, recipes: [recipe, ...data.recipes] } };
}

export function deleteRecipe(data: Recipes, id: unknown): RecipesResult<{ data: Recipes }> {
  if (typeof id !== "string" || !data.recipes.some((r) => r.id === id)) return { ok: false, error: "That recipe is no longer saved." };
  return { ok: true, data: { ...data, recipes: data.recipes.filter((r) => r.id !== id) } };
}

/** The recipes on disk, or none. Never throws. */
export function readRecipes(dir: string): Recipes {
  const path = recipesPath(dir);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return emptyRecipes(); }
  try {
    return coerceRecipes(JSON.parse(text));
  } catch {
    // A file that does not parse is set aside, not overwritten by the next save: the recipes in it can be recovered.
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* left as it is */ }
    return emptyRecipes();
  }
}

/** Write the recipes whole, via a temp file. Never throws. */
export function writeRecipes(dir: string, value: Recipes): RecipesResult<{ data: Recipes }> {
  const data = coerceRecipes(value);
  const path = recipesPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read, change, write: the IPC handlers' one shape. */
export function updateRecipes<T extends { data: Recipes }>(dir: string, change: (data: Recipes) => RecipesResult<T>): RecipesResult<T> {
  const next = change(readRecipes(dir));
  if (!next.ok) return next;
  const written = writeRecipes(dir, next.data);
  if (!written.ok) return written;
  (next as { data: Recipes }).data = written.data;
  return next;
}

/** A recipe as the window gets it: with its share link. */
export function recipeForWindow(recipe: Recipe): Recipe & { link: string } {
  return { ...recipe, link: recipeLink(recipe) };
}
