// ATO-1034: chat folders. The pure half of renderer/chat-folders.js is
// loaded as a CommonJS module; main/chat-folders.ts is checked against the
// built output (npm run build first), like core-update-notice.test.mjs.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../renderer/chat-folders.js");
const { chatMenuItems } = require("../renderer/chat-list.js");

test("a new folder goes on top with a free name", () => {
  const st = F.foldersEmpty();
  const a = F.folderAdd(st, "New folder");
  const b = F.folderAdd(st, "New folder");
  assert.deepEqual(st.folders.map((f) => f.name), ["New folder 2", "New folder"]);
  assert.match(a, /^f[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("put, group, and a deleted folder keeps its chats out of every folder", () => {
  const st = F.foldersEmpty();
  const work = F.folderAdd(st, "Work");
  assert.ok(F.folderPut(st, "s1", work));
  assert.ok(!F.folderPut(st, "s2", "fnope"), "an unknown folder is refused");
  const rows = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
  const g = F.folderGroups(st, rows);
  assert.deepEqual(g.groups[0].rows.map((r) => r.id), ["s1"]);
  assert.deepEqual(g.loose.map((r) => r.id), ["s2", "s3"]);
  assert.ok(F.folderRemove(st, work));
  assert.equal(st.chats.s1, null);
  assert.equal(F.folderGroups(st, rows).loose.length, 3);
});

test("imported chats sort into a folder per app, once, and never against the person", () => {
  const st = F.foldersEmpty();
  const sessions = [{ id: "claude-code:abc" }, { id: "codex:1" }, { id: "claude-code:def" }, { id: "plain-uuid" }, { id: "hermes:x" }];
  F.folderPut(st, "hermes:x", null);   // the person took it out of every folder
  assert.equal(F.folderAutoSort(st, sessions), 3);
  assert.deepEqual(st.folders.map((f) => f.name), ["Claude Code", "Codex"]);
  assert.equal(F.folderOf(st, "claude-code:def").name, "Claude Code");
  assert.equal(F.folderOf(st, "plain-uuid"), null);
  assert.equal(F.folderOf(st, "hermes:x"), null);
  assert.equal(F.folderAutoSort(st, sessions), 0, "a second pass moves nothing");
  const off = F.foldersEmpty(); off.autoSort = false;
  assert.equal(F.folderAutoSort(off, sessions), 0);
});

test("ATO-1253: Claude Code chats go into a folder per project, duplicates disambiguated", () => {
  const st = F.foldersEmpty();
  const sessions = [
    { id: "claude-code:a1", workingDir: "/Users/me/src/atomic-agent" },
    { id: "claude-code:a2", workingDir: "/Users/me/src/atomic-agent/" },
    { id: "claude-code:b1", workingDir: "/Users/me/work/client/app" },
    { id: "claude-code:c1", workingDir: "/Users/me/play/app" },
    { id: "claude-code:w1", workingDir: "C:\\Users\\me\\site" },
    { id: "claude-code:x1" },
    { id: "codex:1", workingDir: "/Users/me/src/atomic-agent" },
  ];
  assert.equal(F.folderAutoSort(st, sessions), 7);
  const name = (sid) => F.folderOf(st, sid).name;
  assert.equal(name("claude-code:a1"), "atomic-agent");
  assert.equal(F.folderOf(st, "claude-code:a2").id, F.folderOf(st, "claude-code:a1").id, "one folder per project path");
  assert.equal(name("claude-code:b1"), "app");
  assert.equal(name("claude-code:c1"), "app (play)");
  assert.equal(name("claude-code:w1"), "site");
  assert.equal(name("claude-code:x1"), "Claude Code", "no project known: the app's folder");
  assert.equal(name("codex:1"), "Codex", "other apps keep a folder per app");
  const before = JSON.stringify(st);
  assert.equal(F.folderAutoSort(st, sessions), 0, "a re-run changes nothing and makes no duplicates");
  assert.equal(JSON.stringify(st), before);
  assert.equal(st.folders.length, 6);
});

test("ATO-1253: a re-run moves sorted chats to their project, never the person's", () => {
  const st = F.foldersEmpty();
  F.folderAutoSort(st, [{ id: "claude-code:a" }, { id: "claude-code:b" }]);
  assert.equal(F.folderOf(st, "claude-code:a").name, "Claude Code");
  const mine = F.folderAdd(st, "Mine");
  F.folderPut(st, "claude-code:b", mine);   // the person's choice
  const renamed = F.folderForProject(st, "/p/web");
  F.folderRename(st, renamed.id, "Website");
  F.folderAutoSort(st, [{ id: "claude-code:a", workingDir: "/p/web" }, { id: "claude-code:b", workingDir: "/p/web" }]);
  assert.equal(F.folderOf(st, "claude-code:a").name, "Website", "a renamed project folder keeps its project");
  assert.equal(F.folderOf(st, "claude-code:b").name, "Mine");
  // A folder of the project's name the person made is used; deleting a project folder leaves its chats alone.
  const own = F.folderAdd(st, "api");
  F.folderAutoSort(st, [{ id: "claude-code:c", workingDir: "/p/api" }]);
  assert.equal(F.folderOf(st, "claude-code:c").id, own);
  F.folderRemove(st, own);
  F.folderAutoSort(st, [{ id: "claude-code:c", workingDir: "/p/api" }]);
  assert.equal(F.folderOf(st, "claude-code:c"), null);
  assert.ok(!(own in st.projects));
});

test("ATO-1253: a file from before splits its one Claude Code folder into projects, once", () => {
  const st = F.foldersCoerce({ folders: [{ id: "fcc", name: "Claude Code" }, { id: "fcx", name: "Codex" }],
    chats: { "claude-code:a": "fcc", "claude-code:b": "fcc", "claude-code:old": "fcc", "codex:1": "fcx" } });
  assert.equal(st.projectSort, false);
  F.folderAutoSort(st, [{ id: "claude-code:a", workingDir: "/p/one" }, { id: "claude-code:b", workingDir: "/p/two" }, { id: "codex:1" }]);
  assert.equal(F.folderOf(st, "claude-code:a").name, "one");
  assert.equal(F.folderOf(st, "claude-code:b").name, "two");
  assert.equal(F.folderOf(st, "codex:1").name, "Codex");
  assert.equal(st.projectSort, true);
  // A chat past the list's rows stays where it was, still marked as sorted, and moves when it shows up.
  assert.equal(F.folderOf(st, "claude-code:old").name, "Claude Code");
  F.folderAutoSort(st, [{ id: "claude-code:old", workingDir: "/p/one" }]);
  assert.equal(F.folderOf(st, "claude-code:old").name, "one");
  // Empty now; the next file from before would remove it, a person's own "Claude Code" folder later is theirs.
  const again = F.foldersCoerce({ folders: [{ id: "fcc", name: "Claude Code" }], chats: { "claude-code:a": "fcc" } });
  F.folderAutoSort(again, [{ id: "claude-code:a", workingDir: "/p/one" }]);
  assert.ok(!again.folders.some((f) => f.name === "Claude Code"), "the emptied old folder goes");
});

test("rename checks the name; a deleted chat leaves the file", () => {
  const st = F.foldersEmpty();
  const id = F.folderAdd(st, "A");
  assert.ok(!F.folderRename(st, id, "   "));
  assert.ok(F.folderRename(st, id, "  Research\n notes "));
  assert.equal(F.folderById(st, id).name, "Research notes");
  F.folderPut(st, "s1", id);
  assert.ok(F.folderForget(st, "s1"));
  assert.ok(!("s1" in st.chats));
});

test("coerce drops dangling links and keeps autoSort on unless turned off", () => {
  const st = F.foldersCoerce({ folders: [{ id: "fa", name: "A" }, { id: "fa", name: "dup" }, { id: "fb", name: " " }], chats: { s1: "fa", s2: "fz", s3: null } });
  assert.deepEqual(st.folders.map((f) => f.id), ["fa"]);
  assert.deepEqual(st.chats, { s1: "fa", s3: null });
  assert.equal(st.autoSort, true);
  assert.equal(F.foldersCoerce({ autoSort: false }).autoSort, false);
});

test("the row menu offers Move to folder only for a stored chat", () => {
  assert.deepEqual(chatMenuItems({ folders: true }).map((i) => i.verb), ["pin", "unread", "rename", "fpick", "delask"]);
  assert.ok(!chatMenuItems({}).some((i) => i.verb === "fpick"));
});

test("renderer wiring: sidebar, palette, delete and boot use the folders", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(src, /foldersSidebarHTML\(ch\.groups\)/);
  assert.match(src, /folderPaletteWord\(s\.id\)/);
  assert.match(src, /folderForget\(FOLDERS\.state, v\)/);
  assert.match(src, /loadFolders\(\);/);
  assert.match(src, /foldersAfterSessions\(\);/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('<script src="chat-folders.js"') > 0 && html.indexOf('<script src="chat-folders.js"') < html.indexOf('<script src="renderer.js"'));
});

// main/chat-folders.ts, against the built output.
let M = null;
try { M = require("../out/main/chat-folders.js"); } catch { M = null; }
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

test("main writes the file whole and reads back a checked value", { skip: !M && "run npm run build first" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "folders-")); dirs.push(dir);
  assert.deepEqual(M.readChatFolders(dir), { version: 1, folders: [], chats: {}, autoSort: true, projects: {}, auto: {}, projectSort: true });
  const res = M.writeChatFolders(dir, { folders: [{ id: "fa", name: "A", collapsed: true }, { id: "bad id", name: "x" }], chats: { s1: "fa", s2: "fb", s3: null },
    autoSort: false, projects: { fa: "/src/A", fz: "/gone" }, auto: { s1: true, s2: true, s3: true }, projectSort: true });
  assert.equal(res.ok, true);
  assert.deepEqual(M.readChatFolders(dir), { version: 1, folders: [{ id: "fa", name: "A", collapsed: true }], chats: { s1: "fa", s3: null },
    autoSort: false, projects: { fa: "/src/A" }, auto: { s1: true }, projectSort: true });
  // A file from before ATO-1253 has no projectSort: its Claude Code chats are split into project folders once.
  assert.equal(M.coerceChatFolders({ folders: [] }).projectSort, false);
  writeFileSync(M.chatFoldersPath(dir), "not json");
  assert.deepEqual(M.readChatFolders(dir).folders, []);
});

test("review fixes: no Folders block without folders, Chats head offers New folder, filing unpins", () => {
  const src = readFileSync(new URL("../renderer/chat-folders.js", import.meta.url), "utf8");
  assert.match(src, /if \(!groups\.length\) return '';/);
  const r = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(r, /sb-fnew" data-act="fnew:"/);
  assert.match(r, /ch\.rows\.length \|\| ch\.filed \? '' : '<div class="sb-empty">No chats yet<\/div>'/);
  assert.match(r, /if \(fid && PREFS\.pinned\.includes\(sid\)\)/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /\(sb\.folders \?\? 0\) > 0 \? \["Folders"\]/);
});
