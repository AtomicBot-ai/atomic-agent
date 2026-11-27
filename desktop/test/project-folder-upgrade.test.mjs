// ATO-2411: Edit project on a project with no disk folder (a chat folder)
// shows the Folder row with Choose folder…; a folder picked there shows the
// model row, and Save turns the chat folder into a projects-store project
// with its name, instructions and chats (renderer/project-folder-upgrade.js,
// renderer/project-edit-extras.js). A new chat in a project then runs on the
// project folder's model (chat-projects.js projectPendingFolder).
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const U = require("../renderer/project-folder-upgrade.js");

/* ---- pure ---- */

test("the plan carries the folder's name, instructions, fold and chats; an unknown folder has none", () => {
  const folders = { folders: [{ id: "f1", name: "Marketing", collapsed: true, instructions: "Be brief" }, { id: "f2", name: "Other" }],
    chats: { s1: "f1", s2: "f2", s3: "f1", s4: null } };
  assert.deepEqual(U.folderUpgradePlan(folders, "f1"), { name: "Marketing", instructions: "Be brief", collapsed: true, chats: ["s1", "s3"] });
  assert.deepEqual(U.folderUpgradePlan(folders, "f2"), { name: "Other", instructions: "", collapsed: false, chats: ["s2"] });
  assert.equal(U.folderUpgradePlan(folders, "f9"), null);
  assert.equal(U.folderUpgradePlan(null, "f1"), null);
});

/* ---- the sheet, in one context with the globals it reads at call time ---- */

function load(opts = {}) {
  const ctx = {
    console, URL, setTimeout: () => 0, localStorage: undefined, document: undefined, window: undefined, navigator: undefined,
    esc: (s) => String(s), ic: (n) => "<" + n + ">", lucideIcon: (n) => "<" + n + ">", chatRow: (r) => "[row " + r.id + "]",
    toasts: [], saved: [], assigned: [], models: [], rendered: 0, foldersSaved: 0,
  };
  ctx.toast = (t, m) => ctx.toasts.push(t + (m ? ": " + m : ""));
  // As renderer.js: a render draws the open sheet (which sets up its extras on the first draw).
  ctx.render = () => { ctx.rendered++; if (ctx.S.overlay === "pedit" && typeof ctx.projectEditHTML === "function") ctx.lastSheet = ctx.projectEditHTML(); };
  ctx.act = () => {};
  ctx.savePrefs = () => {};
  ctx.sheet = (title, body, foot) => "<sheet " + title + ">" + body + foot;
  ctx.S = { sessionId: null, agentSession: null, overlay: null, busy: false, log: [] };
  ctx.PREFS = { pinned: [] };
  ctx.SESSIONS = [{ id: "s-a", workingDir: "/Users/me" }, { id: "s-b", workingDir: "/src/other" }, { id: "s-loose", workingDir: "/Users/me" }];
  ctx.homeDir = () => "/Users/me";
  ctx.SEL = { open: false, modelsFor: null, models: [], modelsBusy: false, modelsErr: null };
  ctx.SEL_GROUPS = new Map([["openrouter", { models: [{ id: "openai/gpt-5" }, { id: "x/y" }] }]]);
  ctx.SEL_LIVE_MODELS = new Map();
  ctx.BSW = { readyLoaded: true, readyIds: ["openrouter"] };
  ctx.selProviders = () => [{ id: "openrouter", kind: "openrouter" }];
  ctx.providerWord = (id) => (id === "openrouter" ? "OpenRouter" : id);
  ctx.liveBackend = () => "cloud";
  ctx.selLoadGroups = () => {};
  ctx.selActiveProviderId = () => "openrouter";
  ctx.selLoadModels = () => {};
  ctx.bswRefreshFacts = () => {};
  ctx.BR = {
    projectsList: async () => ({ ok: true, data: { projects: [], chats: {} } }),
    projectsSave: async (p) => {
      ctx.saved.push(p);
      if (opts.saveFails) return { ok: false, error: "disk is read-only" };
      return { ok: true, data: { id: "pnewone1", name: p.name, folder: p.folder, instructions: p.instructions, createdAt: 2 } };
    },
    projectsAssign: async (p) => { ctx.assigned.push(p); return { ok: true }; },
    projectsInstructionsFile: async () => ({ ok: true, file: { path: "/src/app/AGENTS.md", name: "AGENTS.md", exists: true, head: "# rules", also: [] } }),
    overnightPickFolder: async () => opts.pick || "/src/new",
    projectModels: async () => ({ ok: true, remote: false, folders: {} }),
    setProjectModel: async (dir, pick) => { ctx.models.push([dir, pick]); return { ok: true, folders: {} }; },
  };
  vm.createContext(ctx);
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js", "project-model.js", "project-edit-extras.js", "project-folder-upgrade.js"]) {
    vm.runInContext(readFileSync(new URL("../renderer/" + f, import.meta.url), "utf8"), ctx, { filename: f });
  }
  vm.runInContext(`
    saveFolders = () => { foldersSaved++; };
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}], chats: {}});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'merketinf', collapsed: true, instructions: 'Sell well'}], chats: {'s-a': 'f1', 's-b': 'f1', 's-loose': null}});
    ProjectModels.state.loaded = true;
    ProjectModels.state.folders = {'/src/app': {providerId: 'openrouter', model: 'openai/gpt-5'}};
  `, ctx);
  return ctx;
}
const tick = () => new Promise((r) => setImmediate(r));

test("Edit project on a project with no disk folder shows the Folder row with Choose folder…, and no model yet", () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'f1')", c);
  const html = vm.runInContext("projectEditHTML()", c);
  assert.match(html, /<label class="sd-cap">Folder<\/label>/);
  assert.match(html, /None\. Chats work in the folder the window shows\./);
  assert.match(html, /data-pex="folder">Choose folder…<\/button>/);
  assert.match(html, /Choose a folder to give this project its own model/);
  assert.doesNotMatch(html, /pedit-model|Change folder…|AGENTS\.md/, "no model or AGENTS.md line before there is a folder");
  assert.equal(JSON.stringify(vm.runInContext("projectEditExtrasFields(PROJECTS.edit)", c)), "{}");
});

test("a folder picked shows it, the model row and the pending AGENTS.md line; Undo change takes it back", async () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'f1')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  const html = vm.runInContext("projectEditHTML()", c);
  assert.match(html, /<span class="mono grow" title="\/src\/new">\/src\/new<\/span>/);
  assert.match(html, /data-pex="folderundo">Undo change<\/button>/);
  assert.match(html, /data-pex="folder">Change folder…<\/button>/);
  // ATO-2745: it is not saved yet, so the line does not start with "Saved".
  assert.match(html, /After you save, new chats open there and the project gets its own model/);
  assert.doesNotMatch(html, /Saved, new chats/);
  assert.match(html, /<label class="sd-cap" for="pedit-model">Model for this project<\/label>/);
  assert.match(html, /<option value="" selected>Same as the app<\/option>/);
  assert.match(html, /<optgroup label="OpenRouter">/);
  assert.match(html, /The new folder’s AGENTS\.md is read once you save\./);
  assert.deepEqual({ ...vm.runInContext("projectEditExtrasFields(PROJECTS.edit)", c) }, { folder: "/src/new" });   // copied out of the vm realm
  vm.runInContext("pexRepaint(PROJECTS.edit, () => { PROJECTS.edit.x.folder = ''; }, true)", c);
  assert.match(vm.runInContext("projectEditHTML()", c), /Choose folder…/);
  assert.doesNotMatch(vm.runInContext("projectEditHTML()", c), /pedit-model/);
});

test("Save makes a store project with the name, instructions and chats, the chat folder goes, the model is saved for the folder", async () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'f1'); PROJECTS.edit.name = 'Marketing'; PROJECTS.edit.instructions = 'Sell better'; PROJECTS.newFor = {id: 'f1', log: S.log};", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  vm.runInContext("PROJECTS.edit.x.model = pexModelValue({providerId: 'openrouter', model: 'x/y'});", c);
  await vm.runInContext("projectEditSave()", c);
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(c.saved)), [{ name: "Marketing", folder: "/src/new", instructions: "Sell better" }], "a new store project, no id");
  const projects = JSON.parse(JSON.stringify(vm.runInContext("PROJECTS.state.projects", c)));
  assert.equal(projects[0].id, "pnewone1");
  assert.equal(projects[0].folder, "/src/new");
  assert.equal(projects[0].name, "Marketing");
  // The folder's chats are the project's now, by id; the loose chat is left alone.
  assert.deepEqual(c.assigned.map((a) => a.sessionId).sort(), ["s-a", "s-b"]);
  assert.ok(c.assigned.every((a) => a.projectId === "pnewone1"));
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("PROJECTS.state.chats", c))), { "s-a": "pnewone1", "s-b": "pnewone1" });
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 0, "the chat folder is gone");
  assert.equal(vm.runInContext("FOLDERS.state.chats['s-a']", c), null, "its chats are out of every folder, as a chat put in a store project is");
  assert.ok(c.foldersSaved >= 1);
  assert.equal(vm.runInContext("PROJECTS.collapsed.has('pnewone1')", c), true, "the fold state follows");
  assert.deepEqual(JSON.parse(JSON.stringify(c.models)), [["/src/new", { providerId: "openrouter", model: "x/y" }]]);
  assert.equal(vm.runInContext("PROJECTS.newFor.id", c), "pnewone1", "an empty chat opened in it opens in the store project");
  assert.equal(vm.runInContext("PROJECTS.edit", c), null, "the sheet closed");
  assert.equal(vm.runInContext("S.overlay", c), null);
  assert.ok(c.toasts.some((t) => /Project folder set/.test(t)));
  // The sidebar now draws the project with both chats, under Projects.
  const groups = vm.runInContext("projectGroups(PROJECTS.state, SESSIONS, FOLDERS.state, '/Users/me')", c);
  const g = JSON.parse(JSON.stringify(groups)).groups.find((x) => x.project.id === "pnewone1");
  assert.deepEqual(g.rows.map((r) => r.id), ["s-a", "s-b"]);
});

test("a folder that is already another project is refused, and nothing is saved", async () => {
  const c = load({ pick: "/src/app" });
  vm.runInContext("projectAct('pedit', 'f1')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  assert.equal(vm.runInContext("PROJECTS.edit.x.folder", c), "");
  assert.match(vm.runInContext("projectEditHTML()", c), /That folder is already the project “app”\./);
  await vm.runInContext("projectEditSave()", c);
  assert.deepEqual(c.saved, []);
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 1, "the chat folder stays");
});

test("when the store refuses, the chat folder and its chats stay and the sheet shows the error", async () => {
  const c = load({ saveFails: true });
  vm.runInContext("projectAct('pedit', 'f1')", c);
  await vm.runInContext("pexPickFolder(PROJECTS.edit)", c);
  await vm.runInContext("projectEditSave()", c);
  await tick();
  assert.equal(c.saved.length, 1);
  // ATO-2745: a sentence with a period, not the store's raw words.
  assert.equal(vm.runInContext("PROJECTS.edit.error", c), "The project was not saved. Try again in a moment.");
  assert.equal(vm.runInContext("PROJECTS.edit.saving", c), false);
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 1);
  assert.equal(vm.runInContext("FOLDERS.state.chats['s-a']", c), "f1");
  assert.deepEqual(c.assigned, []);
  assert.equal(vm.runInContext("PROJECTS.state.projects.length", c), 1);
});

test("Save without a folder picked is the plain rename, as before", async () => {
  const c = load();
  vm.runInContext("projectAct('pedit', 'f1'); PROJECTS.edit.name = 'Growth';", c);
  await vm.runInContext("projectEditSave()", c);
  assert.deepEqual(c.saved, []);
  assert.equal(vm.runInContext("FOLDERS.state.folders[0].name", c), "Growth");
  assert.equal(vm.runInContext("FOLDERS.state.folders[0].instructions", c), "Sell well");
});

test("the folder a new chat's turn takes its model from: the pending project's, else none", () => {
  const c = load();
  assert.equal(vm.runInContext("projectPendingFolder()", c), "", "no empty chat waiting in a project");
  vm.runInContext("PROJECTS.newFor = {id: 'paaaaaa', log: S.log}", c);
  assert.equal(vm.runInContext("projectPendingFolder()", c), "/src/app");
  assert.equal(vm.runInContext("projectPendingFolder('paaaaaa')", c), "/src/app", "named outright, after projectForNewTurn took it");
  assert.equal(vm.runInContext("projectPendingFolder('f1')", c), "", "a project with no disk folder names none");
  vm.runInContext("S.agentSession = 'stored'", c);
  assert.equal(vm.runInContext("projectPendingFolder()", c), "", "a stored chat has its own folder");
});

test("the wiring: the script after the extras, the hook in Save, and the turn's model read through the pending project", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  assert.ok(at("project-folder-upgrade.js") > at("project-edit-extras.js") && at("project-folder-upgrade.js") < at("renderer.js"));
  const cp = readFileSync(new URL("../renderer/chat-projects.js", import.meta.url), "utf8");
  assert.match(cp, /if \(e\.x && e\.x\.folder && typeof projectEditFolderUpgrade === 'function'\) \{ await projectEditFolderUpgrade\(e, name\); return; \}/);
  assert.match(cp, /the project has no model of its own\. A folder can be added later in Edit project\./, "New project says what a project with no folder gives up");
  const r = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(r, /projectTurnModel\(session, forProject\)\)/);
  assert.match(r, /const pending = !sessionId && typeof projectPendingFolder === 'function' \? projectPendingFolder\(projectId\) : '';/);
  assert.match(r, /ProjectModels\.folderOf\(sessionId \|\| null, pending \|\| workingDir\(\)\)/);
  assert.match(r, /const folder = ProjectModels\.folderOf\(S\.agentSession \|\| null, pending \|\| workingDir\(\)\);/, "a switcher pick in that empty chat is saved for the same folder");
});

// ATO-2745: the store's refusals in words, each with its reason and a period.
test("folderUpgradeError says why, ends with a period, and never quotes the store", () => {
  const { folderUpgradeError } = require("../renderer/project-folder-upgrade.js");
  assert.match(folderUpgradeError("at most 200 projects"), /as many projects as the app keeps\. Remove one first\.$/);
  assert.match(folderUpgradeError("project instructions are longer than 20000 characters"), /instructions are too long/);
  assert.match(folderUpgradeError("project folder must be an absolute path"), /that folder cannot be used\. Choose it again\.$/);
  assert.equal(folderUpgradeError("EIO: something"), "The project was not saved. Try again in a moment.");
  assert.equal(folderUpgradeError(undefined), "The project was not saved. Try again in a moment.");
  for (const raw of ["at most 200 projects", "project folder required", "project name required", "x"]) {
    const line = folderUpgradeError(raw);
    assert.ok(line.endsWith("."), line);
    assert.ok(!line.includes(raw) || raw === "x", line);
  }
});
