// W2 QA (16.11): one kind of group in the sidebar, Projects. A project has a
// folder on disk (the projects store) or none (a chat folder, chat-folders.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { projectItems } = require("../renderer/chat-list.js");
const F = require("../renderer/chat-folders.js");

test("projects with and without a disk folder are one list, the latest chat first", () => {
  const groups = [
    { project: { id: "paaaaaa", name: "app", folder: "/src/app", createdAt: 10 }, rows: [{ id: "s1", updatedAt: 100 }] },
    { project: { id: "pbbbbbb", name: "site", folder: "/src/site", createdAt: 20 }, rows: [] },
  ];
  const folders = [
    { folder: { id: "f1", name: "Marketing", collapsed: false }, rows: [{ id: "s2", updatedAt: 300 }] },
    { folder: { id: "f2", name: "New one", collapsed: false, createdAt: 200 }, rows: [] },
  ];
  const items = projectItems(groups, folders);
  assert.deepEqual(items.map((i) => i.id), ["f1", "f2", "paaaaaa", "pbbbbbb"]);
  assert.deepEqual(items.map((i) => i.kind), ["folder", "folder", "project", "project"]);
  assert.equal(items[0].name, "Marketing");
});

test("a folder keeps its instructions and when it was made; a new one is stamped", () => {
  const st = F.foldersCoerce({ folders: [{ id: "fa", name: "A", instructions: "  be brief ", createdAt: 5 }, { id: "fb", name: "B", instructions: 3 }] });
  assert.deepEqual(st.folders, [{ id: "fa", name: "A", collapsed: false, instructions: "be brief", createdAt: 5 }, { id: "fb", name: "B", collapsed: false }]);
  const id = F.folderAdd(st, "C");
  assert.ok(F.folderById(st, id).createdAt > 0);
});

/* The renderer half, in one context with the globals it reads at call time. */
function load() {
  const ctx = {
    console, setTimeout: () => 0, localStorage: undefined, document: undefined, window: undefined,
    esc: (s) => String(s), ic: (n) => "<" + n + ">", lucideIcon: (n) => "<" + n + ">", chatRow: (r) => "[row " + r.id + "]",
    toasts: [], saved: 0, assigned: [], rendered: 0, acts: [],
  };
  ctx.toast = (t) => ctx.toasts.push(t);
  ctx.render = () => { ctx.rendered++; };
  ctx.act = (a) => ctx.acts.push(a);
  ctx.savePrefs = () => {};
  ctx.sheet = (title, body, foot) => "<sheet " + title + ">" + body + foot;
  ctx.S = { sessionId: null, overlay: null, busy: false, log: [] };
  ctx.PREFS = { pinned: [] };
  ctx.BR = {
    projectsList: async () => ({ ok: true, data: { projects: [], chats: {} } }),
    projectsSave: async (p) => ({ ok: true, data: { id: "pnewone1", name: p.name, folder: p.folder, instructions: p.instructions, createdAt: 1 } }),
    projectsAssign: async (p) => { ctx.assigned.push(p); return { ok: true }; },
    overnightPickFolder: async () => "/src/picked",
  };
  vm.createContext(ctx);
  for (const f of ["chat-list.js", "chat-folders.js", "chat-projects.js"]) {
    vm.runInContext(readFileSync(new URL("../renderer/" + f, import.meta.url), "utf8"), ctx, { filename: f });
  }
  vm.runInContext("saveFolders = () => { saved++; };", ctx);
  return ctx;
}

test("the sidebar draws chat folders under Projects, with Edit, Remove and a drop target", () => {
  const c = load();
  vm.runInContext(`
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});
  `, c);
  const html = vm.runInContext(`projectsSidebarHTML([{project: PROJECTS.state.projects[0], rows: []}], [{folder: FOLDERS.state.folders[0], rows: [{id: 's2', updatedAt: 5}]}])`, c);
  assert.match(html, /<span>Projects<\/span>/);
  assert.ok(html.indexOf("Marketing") < html.indexOf(">app<"), "the project with the latest chat first");
  assert.match(html, /data-act="ftoggle:f1" data-fdrop="f1"/);
  assert.match(html, /data-act="ptoggle:paaaaaa" data-fdrop="paaaaaa"/);
  assert.match(html, /data-act="pedit:f1"/);
  assert.match(html, /data-act="pdelask:f1"/);
  assert.match(html, /\[row s2\]/);
  assert.doesNotMatch(html, /Folders/);
});

test("past five projects the rest fold behind Show N more projects", () => {
  const c = load();
  const html = vm.runInContext(`(() => {
    const fs = []; for (let i = 0; i < 8; i++) fs.push({folder: {id: 'f' + i, name: 'P' + i, collapsed: true, createdAt: 100 - i}, rows: []});
    return projectsSidebarHTML([], fs);
  })()`, c);
  assert.match(html, /data-act="pmore:">Show 3 more projects</);
  vm.runInContext(`projectAct('pmore', '')`, c);
  assert.match(vm.runInContext(`projectsSidebarHTML([], [0,1,2,3,4,5].map((i) => ({folder: {id: 'f' + i, name: 'P' + i, collapsed: true}, rows: []})))`, c), /Show fewer projects/);
});

test("New project with no disk folder is a chat folder with its instructions, and a new chat opens in it", async () => {
  const c = load();
  vm.runInContext(`projectAct('pnew', ''); PROJECTS.create.name = 'Marketing'; PROJECTS.create.instructions = 'Write in English';`, c);
  assert.equal(c.S.overlay, "pnew");
  assert.match(vm.runInContext("projectCreateHTML()", c), /Choose folder…/);
  await vm.runInContext("projectCreateSave()", c);
  const f = vm.runInContext("FOLDERS.state.folders[0]", c);
  assert.equal(f.name, "Marketing");
  assert.equal(f.instructions, "Write in English");
  assert.deepEqual(c.acts, ["session:new"]);
  assert.equal(c.S.overlay, null);
  // The first turn carries the folder's id (main reads its instructions), and the chat is filed once it has an id.
  const pid = vm.runInContext("projectForNewTurn()", c);
  assert.equal(pid, f.id);
  vm.runInContext(`projectNoteTurn('t1', '${pid}'); projectFileNewChat('t1', 'sNew')`, c);
  assert.equal(vm.runInContext("FOLDERS.state.chats.sNew", c), f.id);
});

test("New project with a folder goes to the projects store; an empty name is refused", async () => {
  const c = load();
  vm.runInContext(`projectAct('pnew', '')`, c);
  await vm.runInContext("projectCreateSave()", c);
  assert.equal(vm.runInContext("PROJECTS.create.error", c), "Give the project a name");
  await vm.runInContext("projectCreatePick()", c);
  assert.equal(vm.runInContext("PROJECTS.create.name", c), "picked", "named after the folder when no name was typed");
  await vm.runInContext("projectCreateSave()", c);
  assert.equal(vm.runInContext("PROJECTS.state.projects[0].folder", c), "/src/picked");
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 0);
  assert.equal(vm.runInContext("projectForNewTurn()", c), "pnewone1");
});

test("Move to project lists every project; moving into a store project takes the chat out of its folder", () => {
  const c = load();
  vm.runInContext(`
    PROJECTS.state = projectsCoerce({projects: [{id: 'paaaaaa', name: 'app', folder: '/src/app'}]});
    FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});
  `, c);
  const items = JSON.parse(JSON.stringify(vm.runInContext("projectPickItems('s2')", c)));
  assert.deepEqual(items.map((i) => i.label), ["app", "Marketing", "No project", "New project…"]);
  assert.equal(items.find((i) => i.on).label, "Marketing");
  assert.equal(items[3].act, "pnew:s2");
  assert.ok(vm.runInContext("projectPutChat('s2', 'paaaaaa')", c));
  assert.equal(vm.runInContext("FOLDERS.state.chats.s2", c), null);
  assert.equal(vm.runInContext("PROJECTS.state.chats.s2", c), "paaaaaa");
  assert.deepEqual(JSON.parse(JSON.stringify(c.assigned)), [{ sessionId: "s2", projectId: "paaaaaa" }]);
});

test("a project with no disk folder edits and removes like any other", () => {
  const c = load();
  vm.runInContext(`FOLDERS.state = foldersCoerce({folders: [{id: 'f1', name: 'Marketing'}], chats: {s2: 'f1'}});`, c);
  vm.runInContext(`projectAct('pedit', 'f1'); PROJECTS.edit.name = 'Growth'; PROJECTS.edit.instructions = 'Be brief';`, c);
  assert.doesNotMatch(vm.runInContext("projectEditHTML()", c), /class="sd-cap mono"/, "no disk folder line");
  vm.runInContext("projectEditSave()", c);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("FOLDERS.state.folders[0]", c))), { id: "f1", name: "Growth", collapsed: false, instructions: "Be brief" });
  vm.runInContext(`projectAct('pdelask', 'f1')`, c);
  assert.equal(c.S.alert.msg, "Its chats stay, under Chats.");
  vm.runInContext(`projectAct('pdel', 'f1')`, c);
  assert.equal(vm.runInContext("FOLDERS.state.folders.length", c), 0);
  assert.equal(vm.runInContext("FOLDERS.state.chats.s2", c), null);
});
