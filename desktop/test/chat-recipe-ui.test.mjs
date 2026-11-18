// ATO-1072: "Save as recipe…" and the Recipes gallery (renderer/chat-recipe.js).
// The pure half is required; the sheets run in a vm context with the
// renderer.js globals they read stubbed, as test/projects-unified.test.mjs does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const C = require("../renderer/chat-recipe.js");
const src = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const tick = () => new Promise((r) => setImmediate(r));
/* Objects made inside the vm context have its own prototypes: compare them as plain data. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("placeholders, filling, missing values and parameter names", () => {
  assert.deepEqual(C.recipePlaceholders("Do {{a}} then {{ b }} and {{a}}"), ["a", "b"]);
  assert.equal(C.recipeFill("Do {{a}} in {{ b }}", { a: "{{b}}", b: "x" }), "Do {{b}} in x", "a value is text only");
  assert.equal(C.recipeFill("Keep {{c}}", {}), "Keep {{c}}");
  assert.deepEqual(C.recipeMissing([{ key: "a" }, { key: "b" }], { a: " ", b: "y" }), ["a"]);
  assert.equal(C.recipeKeyFrom("Project Folder", []), "project_folder");
  assert.equal(C.recipeKeyFrom("2024", []), "p_2024");
  assert.equal(C.recipeKeyFrom("Отчёт", []), "param");
  assert.equal(C.recipeKeyFrom("Отчёт", ["param", "param_2"]), "param_3");
  assert.match(C.recipeKeyFrom("a".repeat(60), []), /^[a-z][a-z0-9_]{0,31}$/);
  assert.equal(C.recipeFirstQuestion([{ kind: "assistant", text: "hi" }, { kind: "user", text: "  " }, { kind: "user", text: " First \n" }, { kind: "user", text: "Second" }]), "First");
  assert.equal(C.recipeFirstQuestion(null), "");
  // Review fix: a message sent with files keeps no local paths in the recipe.
  assert.equal(C.recipeFirstQuestion([{ kind: "user", text: "Summarise this\n\n[attachments]\n- /Users/a/b.pdf (application/pdf, 2 MB)" }]), "Summarise this");
  assert.equal(C.recipeFirstQuestion([{ kind: "user", text: "\n\n[attachments]\n- /Users/a/b.pdf (application/pdf, 2 MB)" }, { kind: "user", text: "Next" }]), "Next");
  assert.deepEqual(C.recipeParamsFor("{{a}} {{b}} {{a}}", { a: "x", b: "" }), [{ key: "a", default: "x" }, { key: "b" }]);
});

const LINK = "atomicagent://recipe/open?title=%3Cimg%3E&prompt=Week%20%7B%7Bweek%7D%7D%20in%20%7B%7Bfolder%7D%7D&param=week&param=folder%3D~%2FNotes";
const SAVED = { id: "raaaaaaa", title: "<img src=x onerror=alert(1)>", description: '"quoted" & more', prompt: "Week {{week}} in {{folder}}",
  params: [{ key: "week" }, { key: "folder", default: "~/Notes" }], createdAt: 1, updatedAt: 1, link: LINK };

function load() {
  const listeners = [], els = {};
  const ctx = {
    console, setTimeout: () => 0, window: undefined,
    document: {
      addEventListener: (type, fn) => { if (type === "input") listeners.push(fn); },
      getElementById: (id) => els[id] || null,
      querySelector: (sel) => els[sel] || null,
    },
    esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
    ic: (n) => "<i " + n + ">",
    sheet: (title, body, foot) => "<sheet " + ctx.esc(title) + ">" + body + "<foot>" + foot,
    toasts: [], acts: [], copies: [], saves: [], deletes: [], sessions: [], sent: [], rendered: 0, closed: 0,
    els, listeners,
  };
  ctx.toast = (t, s) => ctx.toasts.push([t, s]);
  ctx.render = () => { ctx.rendered++; };
  ctx.act = (a) => { ctx.acts.push(a); if (a === "session:new") ctx.S.overlay = null; };
  ctx.close = () => { ctx.closed++; ctx.S.overlay = null; };
  ctx.copyText = (t) => { ctx.copies.push(t); return Promise.resolve(true); };
  ctx.autosize = () => {};
  ctx.chatById = (id) => (id === "hermes:20260511_1" ? { id, t: "My <chat> & notes" } : null);
  ctx.$ = (sel) => (sel === "#entry" ? (els.entry ||= { value: "", focused: false, focus() { this.focused = true; } }) : null);
  ctx.S = { overlay: null, settings: { pane: "general" }, alert: null, draft: "", busy: false };
  ctx.BR = {
    session: async (id) => { ctx.sessions.push(id); return { ok: true, data: { turns: [{ kind: "user", text: "Summarise <b>notes</b> in the Notes folder" }, { kind: "assistant", text: "ok" }] } }; },
    recipesList: async () => ({ ok: true, recipes: [SAVED] }),
    recipesSave: async (r) => { ctx.saves.push(r); return { ok: true, recipe: { ...r, id: "rbbbbbbb" }, recipes: [{ ...SAVED }, { ...r, id: "rbbbbbbb", params: r.params }] }; },
    recipesDelete: async (id) => { ctx.deletes.push(id); return { ok: true, recipes: [] }; },
    // Never called: a recipe only fills the box.
    send: (...a) => ctx.sent.push(a), chat: (...a) => ctx.sent.push(a),
  };
  vm.createContext(ctx);
  vm.runInContext(src("../renderer/chat-recipe.js"), ctx, { filename: "chat-recipe.js" });
  return ctx;
}
const run = (c, code) => vm.runInContext(code, c);
const input = (c, target) => { for (const fn of c.listeners) fn({ target: { dataset: {}, ...target } }); };

test("Save as recipe… fills the sheet from the stored chat's first question and its title, escaped", async () => {
  const c = load();
  run(c, "recipeAct('save:hermes:20260511_1', close)");
  assert.equal(c.closed, 1, "other overlays go first");
  assert.equal(c.S.settings, null);
  assert.equal(c.S.overlay, "recipe-edit");
  await tick();
  assert.deepEqual(c.sessions, ["hermes:20260511_1"], "the whole id, colons and all, read via BR.session");
  const html = run(c, "recipeSheetHTML()");
  assert.match(html, /<sheet Save as recipe>/);
  assert.ok(html.includes('value="My &lt;chat&gt; &amp; notes"'));
  assert.ok(html.includes("Summarise &lt;b&gt;notes&lt;/b&gt; in the Notes folder</textarea>"));
  assert.doesNotMatch(html, /<b>notes/);
  assert.match(html, /data-act="recipe:param"/);
  assert.match(html, /data-act="recipe:save"/);
  assert.match(html, /No parameters yet/);
});

test("Make a parameter turns the selected words into {{key}} with them as the default; typing keeps the state", async () => {
  const c = load();
  run(c, "recipeAct('save:hermes:20260511_1', close)");
  await tick();
  const text = run(c, "RECIPES.edit.prompt");
  const at = text.indexOf("Notes folder");
  c.els["recipe-prompt"] = { value: text, selectionStart: at, selectionEnd: at + "Notes folder".length };
  run(c, "recipeAct('param', close)");
  assert.equal(run(c, "RECIPES.edit.prompt"), "Summarise <b>notes</b> in the {{notes_folder}}");
  assert.equal(run(c, "RECIPES.edit.defaults.notes_folder"), "Notes folder");
  assert.match(run(c, "recipeSheetHTML()"), /id="recipe-def-notes_folder" data-recipe-default="notes_folder" value="Notes folder"/);
  // Nothing selected: a hint, no change.
  c.els["recipe-prompt"] = { value: run(c, "RECIPES.edit.prompt"), selectionStart: 3, selectionEnd: 3 };
  run(c, "recipeAct('param', close)");
  assert.equal(c.toasts.at(-1)[0], "Select a word first");
  // The fields keep what is typed; a new placeholder redraws only the parameters box.
  c.els["recipe-params"] = { innerHTML: "" };
  input(c, { id: "recipe-title", value: "Weekly <report>" });
  input(c, { id: "recipe-desc", value: "for the team" });
  input(c, { id: "recipe-prompt", value: "Summarise {{folder}} for {{week}}" });
  input(c, { dataset: { recipeDefault: "folder" }, value: "~/Notes" });
  assert.match(c.els["recipe-params"].innerHTML, /data-recipe-default="folder"[\s\S]*data-recipe-default="week"/);
  const e = run(c, "RECIPES.edit");
  assert.deepEqual([e.title, e.description, e.prompt, e.defaults.folder], ["Weekly <report>", "for the team", "Summarise {{folder}} for {{week}}", "~/Notes"]);
});

test("Save sends text and parameters only, then shows the gallery", async () => {
  const c = load();
  run(c, "RECIPES.edit = {id: null, title: 'Weekly', description: '', prompt: 'Summarise {{folder}} for {{week}}', defaults: {folder: '~/Notes', week: ''}, loading: false, saving: false, error: null}; S.overlay = 'recipe-edit';");
  run(c, "recipeAct('save', close)");
  await tick();
  assert.deepEqual(plain(c.saves), [{ title: "Weekly", description: "", prompt: "Summarise {{folder}} for {{week}}", params: [{ key: "folder", default: "~/Notes" }, { key: "week" }] }]);
  assert.equal(c.S.overlay, "recipes");
  assert.equal(run(c, "RECIPES.edit"), null);
  assert.equal(c.toasts.at(-1)[0], "Recipe saved");
  // A name the store would refuse is caught before the round trip.
  run(c, "RECIPES.edit = {id: 'raaaaaaa', title: 'x', description: '', prompt: 'Do {{Bad}}', defaults: {}, loading: false, saving: false, error: null}; S.overlay = 'recipe-edit';");
  run(c, "recipeAct('save', close)");
  assert.equal(c.saves.length, 1);
  assert.match(run(c, "recipeSheetHTML()"), /<sheet Edit recipe>[\s\S]*\{\{Bad\}\}: a parameter name/);
});

test("the gallery lists recipes escaped, with Run, Copy link, Edit and Delete", async () => {
  const c = load();
  run(c, "recipeAct('gallery', close)");
  assert.equal(c.S.overlay, "recipes");
  await tick();
  const html = run(c, "recipeSheetHTML()");
  assert.match(html, /<sheet Recipes>/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.doesNotMatch(html, /<img src=x/);
  assert.ok(html.includes("&quot;quoted&quot; &amp; more · 2 parameters"));
  for (const v of ["run", "copy", "edit", "delask"]) assert.ok(html.includes(`data-act="recipe:${v}:raaaaaaa"`), v);
  run(c, "RECIPES.list = []");
  assert.match(run(c, "recipeSheetHTML()"), /No recipes yet/);
  run(c, "RECIPES.list = null; RECIPES.error = '<b>disk</b> full'");
  assert.ok(run(c, "recipeSheetHTML()").includes("&lt;b&gt;disk&lt;/b&gt; full"));
});

test("Run fills the parameters and puts the text in a NEW chat's box, never sending it", async () => {
  const c = load();
  run(c, "recipeAct('gallery', close)");
  await tick();
  run(c, "recipeAct('run:raaaaaaa', close)");
  let html = run(c, "recipeSheetHTML()");
  assert.match(html, /<sheet &lt;img src=x onerror=alert\(1\)&gt;>/);
  assert.match(html, /data-recipe-value="folder" value="~\/Notes"/, "fields start at the defaults");
  assert.match(html, /data-act="recipe:go" disabled/, "week has no value yet");
  c.els['[data-act="recipe:go"]'] = { disabled: true };
  input(c, { dataset: { recipeValue: "week" }, value: "47" });
  assert.equal(c.els['[data-act="recipe:go"]'].disabled, false);
  html = run(c, "recipeSheetHTML()");
  assert.doesNotMatch(html, /data-act="recipe:go" disabled/);
  run(c, "recipeAct('go', close)");
  assert.deepEqual(c.acts, ["session:new"], "the shared New chat, nothing else");
  assert.equal(c.S.draft, "Week 47 in ~/Notes");
  assert.equal(c.els.entry.value, "Week 47 in ~/Notes");
  assert.equal(c.els.entry.focused, true);
  assert.deepEqual(c.sent, [], "nothing is sent");
  assert.equal(c.toasts.at(-1)[0], "Recipe ready");
  assert.equal(run(c, "RECIPES.run"), null);
});

test("Copy link copies the atomicagent://recipe link; Delete asks first, then deletes", async () => {
  const c = load();
  run(c, "recipeAct('gallery', close)");
  await tick();
  run(c, "recipeAct('copy:raaaaaaa', close)");
  assert.deepEqual(c.copies, [LINK]);
  run(c, "recipeAct('delask:raaaaaaa', close)");
  assert.equal(c.deletes.length, 0, "not before the confirmation");
  assert.equal(c.S.alert.act, "recipe:del:raaaaaaa");
  assert.equal(c.S.alert.ok, "Delete");
  assert.match(c.S.alert.msg, /cannot be undone/);
  run(c, "recipeAct('del:raaaaaaa', close)");
  await tick();
  assert.deepEqual(c.deletes, ["raaaaaaa"]);
  assert.equal(c.S.alert, null);
  assert.deepEqual(plain(run(c, "RECIPES.list")), []);
  assert.equal(c.S.overlay, "recipes", "the gallery stays open");
});

test("Edit opens the sheet with the saved recipe and its defaults", async () => {
  const c = load();
  run(c, "recipeAct('gallery', close)");
  await tick();
  run(c, "recipeAct('edit:raaaaaaa', close)");
  assert.equal(c.S.overlay, "recipe-edit");
  const html = run(c, "recipeSheetHTML()");
  assert.match(html, /<sheet Edit recipe>/);
  assert.match(html, /data-recipe-default="folder" value="~\/Notes"/);
  assert.ok(html.includes('value="&lt;img src=x onerror=alert(1)&gt;"'));
});

test("the hooks: renderer.js act/overlay/palette, the chat row menu, the sidebar row, index.html", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /\n  if \(k === 'recipe'\)\s+\{ recipeAct\(v \|\| '', close\); return; \}/);
  assert.ok(r.indexOf("if (k === 'recipe')") > r.indexOf("if (k === 'export')"), "next to Export…");
  assert.match(r, /if \(S\.overlay === 'recipes' \|\| S\.overlay === 'recipe-edit'\) html \+= recipeSheetHTML\(\);/);
  assert.match(r, /\['star','Recipes…','','','recipe:gallery'\]/);
  const { chatMenuItems } = require("../renderer/chat-list.js");
  const verbs = (o) => chatMenuItems(o).map((i) => i.verb);
  assert.ok(verbs({ exportable: true }).includes("recipe:save"), "a stored chat offers it");
  assert.ok(!verbs({ exportable: false }).includes("recipe:save"), "a chat not stored yet does not");
  assert.equal(chatMenuItems({ exportable: true }).find((i) => i.verb === "recipe:save").label, "Save as recipe…");
  const { sidebarNavItems } = require("../renderer/sidebar-nav.js");
  assert.deepEqual(sidebarNavItems(null).find((n) => n.id === "recipes"), { id: "recipes", label: "Recipes", icon: "scrollText", act: "recipe:gallery", chord: "", on: false });
  const html = src("../renderer/index.html");
  assert.ok(html.indexOf('src="chat-recipe.js"') > 0 && html.indexOf('src="chat-recipe.js"') < html.indexOf('src="renderer.js"'));
});
