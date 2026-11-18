import {
  RECIPE_MAX_PARAMS,
  RECIPE_REFUSED_KEYS,
  recipeFromObject,
  type Recipe,
  type RecipeParseResult,
} from "./recipe-format.js";
import { findHiddenCharacters } from "./hidden-characters.js";

/**
 * A recipe as the `atomicagent://recipe/open` link the desktop opens
 * (ATO-1615, desktop/main/deeplink.ts):
 *
 *   atomicagent://recipe/open?title=Weekly%20report&prompt=Summarise%20%7B%7Bfolder%7D%7D&param=folder=~/Notes
 *
 * The whole recipe travels in the link; nothing is downloaded. The limits
 * here are the desktop parser's, so a link made here is one the app takes
 * and a link the app would refuse is refused here too.
 */

export const RECIPE_LINK_PREFIX = "atomicagent://recipe/open";
/** DEEPLINK_MAX_LENGTH: a whole link. */
export const RECIPE_LINK_MAX_LENGTH = 8192;
/** DEEPLINK_MAX_VALUE / DEEPLINK_MAX_TEXT: one value, and the prompt's. */
const LINK_MAX_VALUE = 2048;
const LINK_MAX_TEXT = 6000;
const LINK_MAX_PARAMS = 64;
const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINK_KEYS: Record<string, number> = { title: 1, name: 1, description: 1, prompt: 1, param: RECIPE_MAX_PARAMS };

export type RecipeLinkResult = { ok: true; link: string } | { ok: false; error: string };

/**
 * The shareable link for a recipe. A parameter's description stays in the
 * file (the link has no place for it). Refused when the link would be
 * longer than the app takes, or when the text holds invisible characters,
 * which the app's link route refuses outright.
 */
export function recipeToLink(recipe: Recipe): RecipeLinkResult {
  for (const [what, text] of recipeTexts(recipe)) {
    if (findHiddenCharacters(text).length > 0) {
      return { ok: false, error: `The recipe ${what} holds invisible or direction-changing characters; the app refuses such a link.` };
    }
  }
  const parts = [`title=${encodeURIComponent(recipe.title)}`];
  if (recipe.description) parts.push(`description=${encodeURIComponent(recipe.description)}`);
  parts.push(`prompt=${encodeURIComponent(recipe.prompt)}`);
  for (const p of recipe.params) {
    parts.push(`param=${encodeURIComponent(p.default !== undefined ? `${p.key}=${p.default}` : p.key)}`);
  }
  const link = `${RECIPE_LINK_PREFIX}?${parts.join("&")}`;
  if (link.length > RECIPE_LINK_MAX_LENGTH) {
    return { ok: false, error: `The link would be ${link.length} characters, over the ${RECIPE_LINK_MAX_LENGTH} the app takes. Shorten the text or share the recipe file instead.` };
  }
  return { ok: true, link };
}

/**
 * An `atomicagent://recipe/open` link back into a recipe, with the desktop
 * parser's shape rules (scheme, host, path, key names, repeat counts,
 * lengths, control characters) and then the recipe rules every file gets.
 * Never throws. Invisible characters are left for `checkRecipe` to report.
 */
export function parseRecipeLink(raw: string): RecipeParseResult {
  if (typeof raw !== "string") return { ok: false, error: "The link is not text." };
  const text = raw.trim();
  if (!text) return { ok: false, error: "The link is empty." };
  if (text.length > RECIPE_LINK_MAX_LENGTH) return { ok: false, error: `The link is too long (over ${RECIPE_LINK_MAX_LENGTH} characters).` };
  if (!text.toLowerCase().startsWith("atomicagent://")) return { ok: false, error: "Not an atomicagent:// link." };
  if (CONTROL_RE.test(text)) return { ok: false, error: "The link holds control characters." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "The link is not a valid address." };
  }
  if (url.username || url.password || url.port) return { ok: false, error: "The link carries a user, password or port, which no recipe link has." };
  if (url.hash && url.hash !== "#") return { ok: false, error: "The link carries a #fragment, which no recipe link has." };
  if (url.hostname.toLowerCase() !== "recipe") return { ok: false, error: "Not a recipe link (atomicagent://recipe/open)." };
  const path = url.pathname.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase()).join("/");
  if (path !== "open" && path !== "") return { ok: false, error: "The recipe link can only open a recipe (atomicagent://recipe/open)." };
  const values = new Map<string, string[]>();
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => { pairs.push([key, value]); });
  if (pairs.length > LINK_MAX_PARAMS) return { ok: false, error: `The link has more than ${LINK_MAX_PARAMS} parameters.` };
  for (const [key, value] of pairs) {
    if (!KEY_RE.test(key)) return { ok: false, error: `The link has a parameter with an odd name (${JSON.stringify(key.slice(0, 40))}).` };
    const isText = key === "prompt";
    if (value.length > (isText ? LINK_MAX_TEXT : LINK_MAX_VALUE)) return { ok: false, error: `The parameter "${key}" is too long.` };
    if ((isText ? TEXT_CONTROL_RE : CONTROL_RE).test(value)) return { ok: false, error: `The parameter "${key}" holds control characters.` };
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const refused = [...values.keys()].find((k) => RECIPE_REFUSED_KEYS.includes(k.toLowerCase()));
  if (refused !== undefined) {
    return { ok: false, error: `A recipe link cannot choose the model, tools, servers, skills or permissions ("${refused}"). Only its text and parameters are used.` };
  }
  for (const [key, list] of values) {
    const max = LINK_KEYS[key];
    if (max === undefined) return { ok: false, error: `The link has a parameter Atomic Agent does not take here ("${key}").` };
    if (list.length > max) return { ok: false, error: max === 1 ? `The parameter "${key}" is given more than once.` : `The parameter "${key}" is given more than ${max} times.` };
  }
  const one = (key: string): string | undefined => values.get(key)?.[0];
  const params = (values.get("param") ?? []).map((entry) => {
    const eq = entry.indexOf("=");
    return eq >= 0 ? { key: entry.slice(0, eq).trim(), default: entry.slice(eq + 1) } : { key: entry.trim() };
  });
  const data: Record<string, unknown> = {};
  if (one("title") !== undefined) data.title = one("title");
  if (one("name") !== undefined) data.name = one("name");
  if (one("description") !== undefined) data.description = one("description");
  if (one("prompt") !== undefined) data.prompt = one("prompt");
  if (params.length > 0) data.params = params;
  return recipeFromObject(data);
}

/** Every piece of a recipe's text with a name for messages, in reading order. */
export function recipeTexts(recipe: Recipe): Array<[string, string]> {
  const out: Array<[string, string]> = [["title", recipe.title]];
  if (recipe.description) out.push(["description", recipe.description]);
  out.push(["prompt", recipe.prompt]);
  for (const p of recipe.params) {
    if (p.default !== undefined) out.push([`default of ${p.key}`, p.default]);
    if (p.description) out.push([`description of ${p.key}`, p.description]);
  }
  return out;
}
