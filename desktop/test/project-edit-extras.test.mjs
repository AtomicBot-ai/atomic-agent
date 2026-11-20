// ATO-1012: the Edit project sheet's folder, model and AGENTS.md line
// (renderer/project-edit-extras.js), the instruction file main names for a
// project's folder (main/project-instructions-file.ts), and a project's
// model following it to a new folder (main/project-model.ts moveProjectModel).
// Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const X = require("../renderer/project-edit-extras.js");
const I = require("../out/main/project-instructions-file.js");
const M = require("../out/main/project-model.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "pex-"))); dirs.push(d); return d; };

/* ---- pure parts ---- */

test("a model pick goes into an option value and back; anything else is no pick", () => {
  const v = X.pexModelValue({ providerId: "openrouter", model: "openai/gpt-5" });
  assert.deepEqual(X.pexParseModel(v), { providerId: "openrouter", model: "openai/gpt-5" });
  assert.equal(X.pexModelValue(null), "");
  assert.equal(X.pexParseModel(""), null);
  assert.equal(X.pexParseModel("not json"), null);
  assert.equal(X.pexParseModel(JSON.stringify(["openrouter"])), null);
});

test("the saved pick is always offered, even before its list is in or when the list lost it", () => {
  const groups = X.pexModelGroups([
    { id: "openrouter", title: "OpenRouter", models: null },
    { id: "anthropic", title: "Anthropic", models: ["claude-sonnet-5"] },
  ], { providerId: "openrouter", model: "openai/gpt-5" });
  assert.deepEqual(groups[0].models, ["openai/gpt-5"]);
  assert.deepEqual(X.pexModelGroups([{ id: "a", models: ["m1"] }], { providerId: "a", model: "m0" })[0].models, ["m0", "m1"]);
  const gone = X.pexModelGroups([], { providerId: "gone", model: "m" });
  assert.deepEqual(gone, [{ id: "gone", title: "gone", models: ["m"] }]);
});

test("the select has Same as the app first, a group per provider, and marks the chosen model", () => {
  const groups = [{ id: "openrouter", title: "OpenRouter", models: ["openai/gpt-5", "x/y"] }, { id: "slow", title: "Slow", models: null }];
  const none = X.pexModelSelectHTML(groups, "", false);
  assert.match(none, /<option value="" selected>Same as the app<\/option>/);
  assert.match(none, /<optgroup label="OpenRouter">/);
  assert.match(none, /<optgroup label="Slow"><option disabled>Loading…<\/option>/);
  const v = X.pexModelValue({ providerId: "openrouter", model: "x/y" });
  const picked = X.pexModelSelectHTML(groups, v, true);
  assert.match(picked, /<select id="pedit-model" class="tk-inp" disabled>/);
  assert.match(picked, /selected>x\/y<\/option>/);
  assert.doesNotMatch(picked, /value="" selected/);
});

test("the AGENTS.md line in words", () => {
  assert.equal(X.pexInstructionsLine(null), null);
  assert.match(X.pexInstructionsLine(null, { pending: true }).text, /read once you save/);
  const none = X.pexInstructionsLine({ exists: false, name: "AGENTS.md" });
  assert.equal(none.open, false);
  assert.match(none.text, /No AGENTS\.md in this folder/);
  const has = X.pexInstructionsLine({ exists: true, name: "CLAUDE.md", head: "# Rules\nbe brief", also: [".claude/CLAUDE.md"] });
  assert.equal(has.text, "Also follows CLAUDE.md (and .claude/CLAUDE.md) in this folder");
  assert.equal(has.open, true);
  assert.equal(has.title, "# Rules\nbe brief");
});

/* ---- main: which instruction file a folder carries ---- */

test("the names and their order are the agent's own", () => {
  const core = readFileSync(new URL("../../src/runtime/project-instruction-files.ts", import.meta.url), "utf8");
  const m = core.match(/export const rootNames = (\[[^\]]*\]);/);
  assert.ok(m, "core still lists rootNames");
  assert.deepEqual([...I.INSTRUCTION_FILE_NAMES], JSON.parse(m[1]));
});

test("the first file the folder has, in the agent's order, with the others named", () => {
  const d = scratch();
  assert.deepEqual(I.instructionsFileFor(d), { path: join(d, "AGENTS.md"), name: "AGENTS.md", exists: false, head: "", also: [] });
  mkdirSync(join(d, ".claude"));
  writeFileSync(join(d, ".claude", "CLAUDE.md"), "nested");
  assert.equal(I.instructionsFileFor(d).name, ".claude/CLAUDE.md");
  writeFileSync(join(d, "CLAUDE.md"), "claude rules");
  writeFileSync(join(d, "AGENTS.md"), "# Agents\nrun the tests");
  const f = I.instructionsFileFor(d);
  assert.equal(f.name, "AGENTS.md");
  assert.equal(f.path, join(d, "AGENTS.md"));
  assert.equal(f.exists, true);
  assert.equal(f.head, "# Agents\nrun the tests");
  assert.deepEqual(f.also, ["CLAUDE.md", ".claude/CLAUDE.md"]);
});

test("only the first 2 KB are read, and a character cut in half is dropped", () => {
  const d = scratch();
  writeFileSync(join(d, "AGENTS.md"), "a".repeat(2047) + "é" + "tail".repeat(1000));
  const f = I.instructionsFileFor(d);
  assert.equal(Buffer.byteLength(f.head), 2047);
  assert.equal(f.head, "a".repeat(2047));
});

test("a link that leads outside the folder counts as no file; one inside is followed", () => {
  const d = scratch(), outside = scratch();
  writeFileSync(join(outside, "secret.md"), "outside");
  symlinkSync(join(outside, "secret.md"), join(d, "AGENTS.md"));
  mkdirSync(join(outside, "dotclaude"));
  writeFileSync(join(outside, "dotclaude", "CLAUDE.md"), "outside too");
  symlinkSync(join(outside, "dotclaude"), join(d, ".claude"));
  const none = I.instructionsFileFor(d);
  assert.equal(none.exists, false, "nothing outside the folder is named or read");
  assert.equal(none.head, "");
  writeFileSync(join(d, "rules.md"), "inside");
  symlinkSync(join(d, "rules.md"), join(d, "CLAUDE.md"));
  const inside = I.instructionsFileFor(d);
  assert.equal(inside.name, "CLAUDE.md");
  assert.equal(inside.path, join(d, "rules.md"));
  assert.equal(inside.head, "inside");
});

test("no answer for a folder that is not one on this computer", () => {
  const d = scratch();
  writeFileSync(join(d, "file.txt"), "x");
  assert.equal(I.instructionsFileFor("relative/path"), null);
  assert.equal(I.instructionsFileFor(join(d, "missing")), null);
  assert.equal(I.instructionsFileFor(join(d, "file.txt")), null);
  assert.equal(I.instructionsFileFor(42), null);
});

/* ---- main: the model follows the folder ---- */

test("a project moved to another folder takes its model along, and its old chats keep it", () => {
  const u = scratch();
  M.writeProjectModel(u, "/src/app", { providerId: "openrouter", model: "openai/gpt-5" });
  M.writeProjectModel(u, "/src/new", { providerId: "anthropic", model: "claude-sonnet-5" });
  const moved = M.moveProjectModel(u, "/src/app/", "/src/new");
  // Review fix: the old folder's pick stays, since chats already in the project still run there.
  assert.deepEqual(moved, {
    "/src/app": { providerId: "openrouter", model: "openai/gpt-5" },
    "/src/new": { providerId: "openrouter", model: "openai/gpt-5" },
  });
  assert.deepEqual(M.readProjectModels(u), moved);
});

test("a folder with no model of its own moves nothing", () => {
  const u = scratch();
  M.writeProjectModel(u, "/src/other", { providerId: "openrouter", model: "m" });
  const before = readFileSync(M.projectModelsPath(u), "utf8");
  assert.equal(M.moveProjectModel(u, "/src/app", "/src/new"), null);
  assert.equal(M.moveProjectModel(u, "/src/other", "/src/other/"), null, "the same folder");
  assert.equal(readFileSync(M.projectModelsPath(u), "utf8"), before);
});

test("main moves the pick when projects:save changes a project's folder, and names the file by project id", () => {
  const src = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(src, /const was = typeof id === "string" \? readProjects\(DESKTOP_STATE_DIR\)\.projects\.find\(\(p\) => p\.id === id\)\?\.folder : undefined;/);
  assert.match(src, /if \(res\.ok && was && was !== res\.project\.folder\) moveProjectModel\(app\.getPath\("userData"\), was, res\.project\.folder\);/);
  assert.match(src, /ipcMain\.handle\("projects:instructionsFile", \(_event, id: unknown\) => \{/);
  assert.match(src, /if \(client\.isRemote\) return \{ ok: false, remote: true/);
  assert.match(src, /const file = instructionsFileFor\(p\.folder\);/);
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /projectsInstructionsFile: \(id: string\) => ipcRenderer\.invoke\("projects:instructionsFile", id\)/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  assert.ok(at("project-edit-extras.js") > at("chat-projects.js") && at("project-edit-extras.js") < at("renderer.js"));
  assert.ok(at("project-model.js") >= 0 && at("project-model.js") < at("project-edit-extras.js"));
});

/* ---- the sheet, in one context with the globals it reads at call time ---- */

function load(opts = {}) {
  const ctx = {
    // URL: project-model.js parses a provider's baseUrl to tell a model on this machine from a cloud one.
    console, URL, setTimeout: () => 0, localStorage: undefined, document: undefined, window: undefined, navigator: undefined,
    esc: (s) => String(s), ic: (n) => "<" + n + ">", lucideIcon: (n) => "<" + n + ">", chatRow: (r) => "[row " + r.id + "]",
    toasts: [], saved: [], assigned: [], models: [], rendered: 0, opened: [],
  };
  ctx.toast = (t, m) => ctx.toasts.push(t + (m ? ": " + m : ""));
  // As renderer.js: a render draws the open sheet (which sets up its extras on the first draw).
  ctx.render = () => { ctx.rendered++; if (ctx.S.overlay === "pedit" && typeof ctx.projectEditHTML === "function") ctx.lastSheet = ctx.projectEditHTML(); };
  ctx.act = () => {};
  ctx.savePrefs = () => {};
  ctx.sheet = (title, body, foot) => "<sheet " + title + ">" + body + foot;
  ctx.S = { sessionId: null, overlay: null, busy: false, log: [] };
  ctx.PREFS = { pinned: [] };
  ctx.SESSIONS = [
    { id: "s-old", workingDir: "/src/app" },
    { id: "s-sub", workingDir: "/src/app/web" },
    { id: "s-put", workingDir: "/src/app" },
    { id: "s-else", workingDir: "/src/elsewhere" },
  ];
  ctx.homeDir = () => "/Users/me";
  ctx.openReplyPath = async (p) => { ctx.opened.push(p); return { ok: true }; };
  // The switcher's model lists (renderer.js) as the sheet reads them.
  ctx.SEL = { open: false, modelsFor: null, models: [], modelsBusy: false, modelsErr: null };
  ctx.SEL_GROUPS = new Map([["openrouter", { models: [{ id: "openai/gpt-5" }, { id: "x/y" }] }]]);
  ctx.SEL_LIVE_MODELS = new Map();
  ctx.BSW = { readyLoaded: true, readyIds: ["openrouter", "lmstudio"] };
  ctx.selProviders = () => [
    { id: "openrouter", kind: "openrouter" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" },
  ];
  ctx.providerWord = (id) => (id === "openrouter" ? "OpenRouter" : id);
  ctx.liveBackend = () => "cloud";
  ctx.selLoadGroups = () => {};
  ctx.selActiveProviderId = () => "openrouter";
  ctx.selLoadModels = () => {};
  ctx.bswRefreshFacts = () => {};
  ctx.BR = {
    projectsList: async () => ({ ok: true, data: { projects: [], chats: {} } }),
    projectsSave: async (p) => { ctx.saved.push(p); return { ok: true, data: { id: p.id, name: p.name, folder: p.folder || "/src/app", instructions: p.instructions, createdAt: 1 } }; },
    projectsAssign: async (p) => { ctx.assigned.push(p); return { ok: true }; },
    projectsInstructionsFile: async () => ({ ok: true, file: { path: "/src/app/AGENTS.md", name: "AGENTS.md", exists: true, head: "# rules", also: [] } }),
    overnightPickFolder: async () => opts.pick || "/src/new",
    projectModels: async () => ({ ok: true, remote: false, folders: {} }),
    setProjectModel: async (dir, pick) => { ctx.models.push([dir, pick]); return { ok: true, folders: {} }; },
  };
  vm.createContext(ctx);
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js", "project-model.js", "project-edit-extras.js"]) {
    vm.runInContext(readFileSync(new URL("../renderer/" + f, import.meta.url), "utf8"), ctx, { filename: f });
  }
  vm.runInContext(`
    saveFolders = () => {};
    PROJECTS.state = projectsCoerce({projects: [
      {id: 'paaaaaa', name: 'app', folder: '/src/app'},
      {id: 'pbbbbbb', name: 'site', folder: '/src/site'},
    ], chats: {'s-put': 'pbbbbbb'}});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {}});
    ProjectModels.state.loaded = true;
    ProjectModels.state.folders = {'/src/app': {providerId: 'openrouter', model: 'openai/gpt-5'}};
  `, ctx);
  if (opts.remote) vm.runInContext("ProjectModels.state.remote = true;", ctx);
  return ctx;
}
const tick = () => new Promise((r) => setImmediate(r));

test("Edit project shows the folder with Change folder…, the folder's AGENTS.md and the cloud models", async () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'paaaaaa')", c);
  await tick();
  const html = vm.runInContext("projectEditHTML()", c);
  assert.match(html, /<span class="mono grow" title="\/src\/app">\/src\/app<\/span>/);
  assert.match(html, /data-pex="folder">Change folder…<\/button>/);
  assert.match(html, /Also follows AGENTS\.md in this folder · <a href="#" data-pex="open">Open<\/a>/);
  assert.match(html, /<label class="sd-cap" for="pedit-model">Model for this project<\/label>/);
  assert.match(html, /<optgroup label="OpenRouter">/);
  assert.doesNotMatch(html, /lmstudio/, "a model on this machine is never a project's own");
  assert.match(html, /selected>openai\/gpt-5<\/option>/, "the folder's saved model is chosen");
  assert.match(html, /Cloud models only\. Local model is shared by all projects\./);
  vm.runInContext("pexOpen(PROJECTS.edit)", c);
  await tick();
  assert.deepEqual(c.opened, ["/src/app/AGENTS.md"], "opened through the reply chips' safe open");
});

test("a remote agent gets no model row, and a chat folder none of the extras", async () => {
  const r = load({ remote: true });
  vm.runInContext("projectAct('pedit', 'paaaaaa')", r);
  await tick();
  const html = vm.runInContext("projectEditHTML()", r);
  assert.doesNotMatch(html, /pedit-model/);
  assert.match(html, /Change folder…/);
  const f = load();
  vm.runInContext("projectAct('pedit', 'f1')", f);
  const fh = vm.runInContext("projectEditHTML()", f);
  assert.doesNotMatch(fh, /Change folder…|pedit-model|AGENTS\.md/);
  assert.equal(JSON.stringify(vm.runInContext("projectEditExtrasFields(PROJECTS.edit)", f)), "{}");
});

test("Change folder… saves the new folder, keeps the project's chats, and saves a changed model for the new folder", async () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'paaaaaa')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  const html = vm.runInContext("projectEditHTML()", c);
  assert.match(html, /title="\/src\/new">\/src\/new</);
  assert.match(html, /New chats open there; chats you already have keep their folder\./);
  assert.match(html, /The new folder’s AGENTS\.md is read once you save\./);
  assert.match(html, /data-pex="folderundo">Keep the old one</);
  vm.runInContext(`PROJECTS.edit.x.model = pexModelValue({providerId: 'openrouter', model: 'x/y'});`, c);
  await vm.runInContext("projectEditSave()", c);
  await tick();
  assert.equal(c.saved.length, 1);
  assert.equal(c.saved[0].folder, "/src/new");
  assert.equal(c.saved[0].id, "paaaaaa");
  // The chats it held by their folder are filed in it by id; one put in another project stays there.
  assert.deepEqual(c.assigned.map((a) => a.sessionId).sort(), ["s-old", "s-sub"]);
  assert.ok(c.assigned.every((a) => a.projectId === "paaaaaa"));
  assert.deepEqual(JSON.parse(JSON.stringify(c.models)), [["/src/new", { providerId: "openrouter", model: "x/y" }]]);
  assert.equal(vm.runInContext("PROJECTS.edit", c), null, "the sheet closed");
});

test("an unchanged model is not written again; Same as the app forgets it", async () => {
  const same = load();
  vm.runInContext("projectAct('pedit', 'paaaaaa')", same);
  await vm.runInContext("projectEditSave()", same);
  await tick();
  assert.equal(same.saved[0].folder, undefined, "no folder sent when it did not change");
  assert.deepEqual(same.models, []);
  assert.deepEqual(same.assigned, []);
  const clear = load();
  vm.runInContext("projectAct('pedit', 'paaaaaa'); PROJECTS.edit.x.model = '';", clear);
  await vm.runInContext("projectEditSave()", clear);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(clear.models)), [["/src/app", null]]);
});

test("moved to a folder with its own model, a project with none shows and keeps that model", async () => {
  // Nadya, 18.11: the new folder's own model stays and the sheet shows it, not "Same as the app".
  const c = load({ pick: "/src/new" });
  vm.runInContext("ProjectModels.state.folders = {'/src/new': {providerId: 'openrouter', model: 'x/y'}}; projectAct('pedit', 'paaaaaa')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  const want = vm.runInContext("pexModelValue({providerId: 'openrouter', model: 'x/y'})", c);
  assert.equal(vm.runInContext("PROJECTS.edit.x.model", c), want);
  assert.equal(vm.runInContext("PROJECTS.edit.x.modelWas", c), want);
  assert.match(vm.runInContext("projectEditHTML()", c), /The new folder already has this model, so the project keeps it\./);
  await vm.runInContext("projectEditSave()", c);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(c.models)), [], "nothing is written: the folder already has it");
  // A project that has its own model still carries it (main copies it on save).
  const k = load({ pick: "/src/new" });
  vm.runInContext("ProjectModels.state.folders = {'/src/app': {providerId: 'openrouter', model: 'openai/gpt-5'}, '/src/new': {providerId: 'openrouter', model: 'x/y'}}; projectAct('pedit', 'paaaaaa')", k);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", k);
  assert.equal(vm.runInContext("PROJECTS.edit.x.model", k), vm.runInContext("pexModelValue({providerId: 'openrouter', model: 'openai/gpt-5'})", k));
});

test("a folder that is already another project is refused; the same folder is no change", async () => {
  const c = load({ pick: "/src/site" });
  vm.runInContext("projectAct('pedit', 'paaaaaa')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  assert.equal(vm.runInContext("PROJECTS.edit.x.folder", c), "");
  assert.match(vm.runInContext("projectEditHTML()", c), /That folder is already the project “site”\./);
  const s = load({ pick: "/src/app/" });
  vm.runInContext("projectAct('pedit', 'paaaaaa')", s);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", s);
  assert.equal(vm.runInContext("PROJECTS.edit.x.folder", s), "");
});

test("chats held only by their folder are the ones kept; filed ones are left alone", () => {
  const c = load();
  const ids = vm.runInContext(`pexChatsToKeep(PROJECTS.state.projects[0], SESSIONS, {'s-put': 'pbbbbbb'}, {'s-sub': 'f1'}, '/Users/me')`, c);
  assert.deepEqual([...ids], ["s-old"]);
});

test("a chat a nested project holds is not pulled into the moved project", () => {
  const c = load();
  // Review fix: project A on /work, project B on /work/app; a chat in /work/app/src belongs to B.
  const ids = vm.runInContext(`pexChatsToKeep({id:'pA', name:'A', folder:'/work'},
    [{id:'c1', workingDir:'/work/app/src'}, {id:'c2', workingDir:'/work/docs'}], {}, {}, '/Users/me',
    [{id:'pA', name:'A', folder:'/elsewhere'}, {id:'pB', name:'B', folder:'/work/app'}])`, c);
  assert.deepEqual([...ids], ["c2"]);
});

test("chat-projects.js keeps only small hooks into the extras", () => {
  const src = readFileSync(new URL("../renderer/chat-projects.js", import.meta.url), "utf8");
  assert.match(src, /typeof projectEditFolderHTML === 'function' \? projectEditFolderHTML\(e, p\)/);
  assert.match(src, /typeof projectEditMoreHTML === 'function' \? projectEditMoreHTML\(e, p\) : ''/);
  assert.match(src, /typeof projectEditExtrasFields === 'function' \? projectEditExtrasFields\(e\) : \{\}/);
  assert.match(src, /if \(typeof projectEditExtrasSaved === 'function'\) projectEditExtrasSaved\(e, p\);/);
  assert.match(src, /const dir = await projectPickFolder\(c\.folder\);/, "New project and Change folder… share one picker");
});
