// ATO-1072: saved recipes (main/recipes-store.ts), against the built output.
// Run: npm run build && npm run test:unit
//
// The link fixtures below are the format the atomicagent://recipe/open route
// parses (main/deeplink.ts, ATO-1615, PR #1568), copied as literals rather
// than imported, since that route ships in its own PR. `routeReads` is a
// short copy of that route's rules, so a link that passes here opens there.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../out/main/recipes-store.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function userData() {
  const d = mkdtempSync(join(tmpdir(), "aa-recipes-"));
  dirs.push(d);
  return d;
}

const WEEKLY = { title: "Weekly report", description: "", prompt: "Summarise {{folder}} for {{week}}", params: [{ key: "folder", default: "~/Notes" }, { key: "week" }] };

/* The ATO-1615 route's reading of a recipe link, in short. */
function routeReads(link) {
  assert.ok(link.length <= 8192, "the whole link fits DEEPLINK_MAX_LENGTH");
  const u = new URL(link);
  assert.equal(u.protocol, "atomicagent:");
  assert.equal(u.hostname, "recipe");
  assert.equal(u.pathname, "/open");
  const got = { title: [], description: [], prompt: [], param: [] };
  u.searchParams.forEach((value, key) => {
    assert.ok(key in got, `only title, description, prompt and param (${key})`);
    if (key === "prompt") { assert.ok(value.length <= 6000); assert.doesNotMatch(value, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/); }
    else { assert.ok(value.length <= 2048); assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/); }
    got[key].push(value);
  });
  assert.ok(got.title.length === 1 && got.prompt.length === 1 && got.description.length <= 1);
  assert.ok(got.param.length <= 16);
  const params = got.param.map((raw) => {
    const eq = raw.indexOf("=");
    return { key: (eq >= 0 ? raw.slice(0, eq) : raw).trim(), default: eq >= 0 ? raw.slice(eq + 1) : "" };
  });
  for (const p of params) { assert.match(p.key, /^[a-z][a-z0-9_]{0,31}$/); assert.ok(p.default.length <= 500); }
  const prompt = got.prompt[0].replace(/\r\n?/g, "\n").trim();
  const used = [...new Set([...prompt.matchAll(/\{\{\s*([^{}\s]*)\s*\}\}/g)].map((m) => m[1]))];
  assert.deepEqual([...used].sort(), params.map((p) => p.key).sort(), "placeholders and params match");
  return { title: got.title[0].trim(), description: (got.description[0] ?? "").trim(), prompt, params };
}

test("the link is the exact shape the recipe route parses", () => {
  assert.equal(R.recipeLink(WEEKLY),
    "atomicagent://recipe/open?title=Weekly%20report&prompt=Summarise%20%7B%7Bfolder%7D%7D%20for%20%7B%7Bweek%7D%7D&param=folder%3D~%2FNotes&param=week");
  const odd = { title: "Fix & ship", description: "a+b #1", prompt: "Line 1\nLine 2 {{x}}", params: [{ key: "x", default: "a=b" }] };
  assert.equal(R.recipeLink(odd),
    "atomicagent://recipe/open?title=Fix%20%26%20ship&description=a%2Bb%20%231&prompt=Line%201%0ALine%202%20%7B%7Bx%7D%7D&param=x%3Da%3Db");
  assert.deepEqual(routeReads(R.recipeLink(odd)), { ...odd, params: [{ key: "x", default: "a=b" }] }, "+, &, # and = stay text");
  assert.deepEqual(routeReads(R.recipeLink(WEEKLY)).params, [{ key: "folder", default: "~/Notes" }, { key: "week", default: "" }]);
});

test("validateRecipe tidies like the route and matches placeholders to params", () => {
  const v = R.validateRecipe({ title: "  Weekly\treport ", description: " x ", prompt: "\r\n Do {{ a }} \r\n then {{a}}\r\n", params: [{ key: "a", default: "" }] });
  assert.equal(v.ok, true);
  assert.deepEqual(v.recipe, { title: "Weekly report", description: "x", prompt: "Do {{ a }} \n then {{a}}", params: [{ key: "a" }] });
  assert.match(R.validateRecipe({ title: "t", prompt: "Do {{b}}", params: [] }).error, /\{\{b\}\}, but it is not a parameter/);
  assert.match(R.validateRecipe({ title: "t", prompt: "Do it", params: [{ key: "a" }] }).error, /not used/);
  assert.match(R.validateRecipe({ title: "t", prompt: "Do {{Bad}}", params: [] }).error, /lowercase letters/);
  assert.match(R.validateRecipe({ title: "t", prompt: "{{a}} {{a}}", params: [{ key: "a" }, { key: "a" }] }).error, /twice/);
  assert.match(R.validateRecipe({ title: "", prompt: "x" }).error, /title/);
  assert.match(R.validateRecipe({ title: "t", prompt: "  " }).error, /task text/);
});

test("the caps are the link route's, so every saved recipe can be shared", () => {
  const ok = (r) => R.validateRecipe({ title: "t", prompt: "x", params: [], ...r }).ok;
  assert.equal(ok({ title: "a".repeat(120) }), true);
  assert.equal(ok({ title: "a".repeat(121) }), false);
  assert.equal(ok({ description: "d".repeat(300) }), true);
  assert.equal(ok({ description: "d".repeat(301) }), false);
  assert.equal(ok({ prompt: "p".repeat(6000) }), true);
  assert.equal(ok({ prompt: "p".repeat(6001) }), false);
  const many = Array.from({ length: 17 }, (_, i) => `k${i}`);
  assert.equal(ok({ prompt: many.slice(0, 16).map((k) => `{{${k}}}`).join(" "), params: many.slice(0, 16).map((key) => ({ key })) }), true);
  assert.equal(ok({ prompt: many.map((k) => `{{${k}}}`).join(" "), params: many.map((key) => ({ key })) }), false);
  assert.equal(ok({ prompt: "{{a}}", params: [{ key: "a", default: "v".repeat(500) }] }), true);
  assert.equal(ok({ prompt: "{{a}}", params: [{ key: "a", default: "v".repeat(501) }] }), false);
  assert.equal(ok({ prompt: "{{a}}", params: [{ key: "a", default: "two\nlines" }] }), false, "a default is one line");
  // Hidden and direction-changing characters, and a broken surrogate, are refused.
  assert.equal(ok({ prompt: "run‮this" }), false);
  assert.equal(ok({ title: "a​b" }), false);
  assert.equal(ok({ prompt: "x\ud800" }), false);
  assert.equal(ok({ prompt: "tab\tand\nlines" }), true);
  assert.equal(ok({ prompt: "bell\u0007" }), false);
  // 6000 Cyrillic letters fit the text cap but not the 8192-character link: refused here, not at the link.
  const long = R.validateRecipe({ title: "t", prompt: "ё".repeat(6000), params: [] });
  assert.equal(long.ok, false);
  assert.match(long.error, /too long to share as a link/);
  const fits = R.validateRecipe({ title: "t", prompt: "ё".repeat(1300), params: [] });
  assert.equal(fits.ok, true);
  routeReads(R.recipeLink(fits.recipe));
});

test("save, update, delete and the round trip through recipes.json", () => {
  const dir = userData();
  assert.deepEqual(R.readRecipes(dir), R.emptyRecipes(), "no file is no recipes");
  const a = R.updateRecipes(dir, (d) => R.saveRecipe(d, WEEKLY, 1000, () => "raaaaaaa"));
  assert.equal(a.ok, true);
  assert.deepEqual(a.recipe, { id: "raaaaaaa", ...WEEKLY, createdAt: 1000, updatedAt: 1000 });
  const b = R.updateRecipes(dir, (d) => R.saveRecipe(d, { title: "Second", prompt: "Hi", params: [] }, 2000, () => "rbbbbbbb"));
  assert.deepEqual(R.readRecipes(dir).recipes.map((r) => r.id), ["rbbbbbbb", "raaaaaaa"], "newest first");
  assert.equal(b.ok, true);
  const edited = R.updateRecipes(dir, (d) => R.saveRecipe(d, { id: "raaaaaaa", ...WEEKLY, title: "Weekly" }, 3000));
  assert.equal(edited.ok, true);
  assert.deepEqual([edited.recipe.title, edited.recipe.createdAt, edited.recipe.updatedAt], ["Weekly", 1000, 3000]);
  assert.match(R.updateRecipes(dir, (d) => R.saveRecipe(d, { id: "rnope000", ...WEEKLY })).error, /no longer saved/);
  const file = JSON.parse(readFileSync(R.recipesPath(dir), "utf8"));
  assert.equal(file.version, 1);
  assert.deepEqual(file.recipes[1], { id: "raaaaaaa", title: "Weekly", description: "", prompt: WEEKLY.prompt, params: WEEKLY.params, createdAt: 1000, updatedAt: 3000 });
  assert.equal(R.updateRecipes(dir, (d) => R.deleteRecipe(d, "rbbbbbbb")).ok, true);
  assert.deepEqual(R.readRecipes(dir).recipes.map((r) => r.id), ["raaaaaaa"]);
  assert.equal(R.updateRecipes(dir, (d) => R.deleteRecipe(d, "rbbbbbbb")).ok, false);
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "the temp file is renamed into place");
  assert.equal(R.recipeForWindow(R.readRecipes(dir).recipes[0]).link, R.recipeLink({ ...WEEKLY, title: "Weekly" }));
});

test("a recipe never carries a model, tools or permissions, even when the input does", () => {
  const s = R.saveRecipe(R.emptyRecipes(), { ...WEEKLY, model: "gpt", tools: ["shell"], permissions: "all", mcp: "x" }, 1, () => "rccccccc");
  assert.equal(s.ok, true);
  assert.deepEqual(Object.keys(s.recipe).sort(), ["createdAt", "description", "id", "params", "prompt", "title", "updatedAt"]);
  assert.doesNotMatch(R.recipeLink(s.recipe), /model|tools|permission|mcp/);
});

test("a corrupt file reads as no recipes and is kept aside; bad entries are dropped", () => {
  const dir = userData();
  writeFileSync(R.recipesPath(dir), "{ not json");
  assert.deepEqual(R.readRecipes(dir), R.emptyRecipes());
  assert.ok(readdirSync(dir).some((f) => f.startsWith("recipes.json.bad-")), "the broken file is kept for recovery");
  const c = R.coerceRecipes({ recipes: [
    { id: "raaaaaaa", ...WEEKLY, createdAt: 5, updatedAt: 9 },
    { id: "raaaaaaa", ...WEEKLY },                              // a duplicate id
    { id: "bad id", ...WEEKLY },                                // not an id
    { id: "rbbbbbbb", title: "t", prompt: "{{x}}", params: [] }, // placeholder with no param
    { id: "rccccccc", title: "t", prompt: "ok", params: [], createdAt: "soon" },
    "nonsense",
  ] });
  assert.deepEqual(c.recipes.map((r) => [r.id, r.createdAt, r.updatedAt]), [["raaaaaaa", 5, 9], ["rccccccc", 0, 0]]);
  assert.deepEqual(R.coerceRecipes(null), R.emptyRecipes());
  assert.deepEqual(R.coerceRecipes({ recipes: "x" }), R.emptyRecipes());
});

test("at most MAX_RECIPES are kept", () => {
  const data = { version: 1, recipes: Array.from({ length: R.MAX_RECIPES }, (_, i) => ({ id: `r${String(i).padStart(7, "0")}`, title: "t", description: "", prompt: "x", params: [], createdAt: 0, updatedAt: 0 })) };
  assert.match(R.saveRecipe(data, { title: "one more", prompt: "x", params: [] }).error, /At most 500/);
});

test("main and preload wire the recipes IPC", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ wireRecipesIpc \} from "\.\/recipes-ipc\.js";/);
  assert.match(main, /wireRecipesIpc\(\{ dir: \(\) => app\.getPath\("userData"\) \}\);/);
  assert.match(main, /SIDEBAR_NAV_EXPECTED = JSON\.stringify\(\["Studio", "Scheduled tasks", "Task board", "Skills", "Plugins", "Recipes"\]\)/);
  const ipc = readFileSync(new URL("../main/recipes-ipc.ts", import.meta.url), "utf8");
  for (const ch of ["recipes:list", "recipes:save", "recipes:delete"]) assert.ok(ipc.includes(`ipcMain.handle("${ch}"`), ch);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  for (const [name, ch] of [["recipesList", "recipes:list"], ["recipesSave", "recipes:save"], ["recipesDelete", "recipes:delete"]]) {
    assert.ok(preload.includes(`${name}:`), name);
    assert.ok(preload.includes(`ipcRenderer.invoke("${ch}"`), ch);
  }
  const store = readFileSync(new URL("../main/recipes-store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(store, /from "electron"/, "the store stays pure");
});
