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
  assert.deepEqual(M.readChatFolders(dir), { version: 1, folders: [], chats: {}, autoSort: true });
  const res = M.writeChatFolders(dir, { folders: [{ id: "fa", name: "A", collapsed: true }, { id: "bad id", name: "x" }], chats: { s1: "fa", s2: "fb" }, autoSort: false });
  assert.equal(res.ok, true);
  assert.deepEqual(M.readChatFolders(dir), { version: 1, folders: [{ id: "fa", name: "A", collapsed: true }], chats: { s1: "fa" }, autoSort: false });
  writeFileSync(M.chatFoldersPath(dir), "not json");
  assert.deepEqual(M.readChatFolders(dir).folders, []);
});
