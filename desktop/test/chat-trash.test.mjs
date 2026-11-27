// Unit tests for ATO-2332 (the chat Trash): main/chat-trash.ts (against the
// built output), the pure half of renderer/chat-trash.js, its act() verbs run
// in a sandbox, and the wiring read from the sources.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const M = require("../out/main/chat-trash.js");
const R = require("../renderer/chat-trash.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 27, 12);
const h = { esc: (s) => String(s).replace(/"/g, "&quot;"), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };

test("coerceTrash keeps one clean entry per id, newest first", () => {
  const out = M.coerceTrash({ entries: [
    { id: "a", title: "A", deletedAt: NOW - 2 * DAY },
    { id: "b", title: 7, deletedAt: NOW },
    { id: "a", title: "again", deletedAt: NOW },
    { id: "", deletedAt: NOW }, { id: "c" }, null, "x",
  ] });
  assert.deepEqual(out, [{ id: "b", title: "", deletedAt: NOW }, { id: "a", title: "A", deletedAt: NOW - 2 * DAY }]);
  assert.deepEqual(M.coerceTrash(undefined), []);
});

test("a chat put in Trash twice keeps its first date; dropping takes it out", () => {
  const one = M.trashPut([], "a", "A", NOW - DAY);
  const two = M.trashPut(one, "a", "A", NOW);
  assert.deepEqual(two, [{ id: "a", title: "A", deletedAt: NOW - DAY }]);
  assert.deepEqual(M.trashDrop(M.trashPut(two, "b", "B", NOW), "a").map((e) => e.id), ["b"]);
});

test("an entry expires at exactly 30 days, not a minute before", () => {
  assert.equal(M.TRASH_DAYS, 30);
  assert.equal(M.trashExpired({ id: "a", title: "", deletedAt: NOW - 30 * DAY }, NOW), true);
  assert.equal(M.trashExpired({ id: "a", title: "", deletedAt: NOW - 30 * DAY + 60_000 }, NOW), false);
});

test("purgeExpired deletes only chats past 30 days, and keeps one the agent could not take", async () => {
  const entries = [
    { id: "young", title: "", deletedAt: NOW - 29 * DAY },
    { id: "old", title: "", deletedAt: NOW - 31 * DAY },
    { id: "old-busy", title: "", deletedAt: NOW - 40 * DAY },
  ];
  const removed = [];
  const out = await M.purgeExpired(entries, NOW, async (id) => {
    removed.push(id);
    if (id === "old-busy") throw new Error("agent restarting");
  });
  assert.deepEqual(removed, ["old", "old-busy"]);   // "young" never reaches the agent
  assert.deepEqual(out.purged, ["old"]);
  assert.deepEqual(out.entries.map((e) => e.id), ["young", "old-busy"]);
});

test("the file round-trips, and a missing or broken file is an empty Trash", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-trash-"));
  try {
    const path = join(dir, "chat-trash.json");
    assert.deepEqual(M.readTrash(path), []);
    M.writeTrash(path, M.trashPut([], "a", "A", NOW));
    assert.deepEqual(M.readTrash(path), [{ id: "a", title: "A", deletedAt: NOW }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ATO-2747: an entry keeps where the chat sat (pinned, archived, folder) through the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-trash-"));
  try {
    const path = join(dir, "chat-trash.json");
    let list = M.trashPut([], "a", "A", NOW, { pinned: true, folder: "f1" });
    list = M.trashPut(list, "b", "B", NOW - DAY, { archived: true, folder: "", pinned: "yes" });
    M.writeTrash(path, list);
    assert.deepEqual(M.readTrash(path), [
      { id: "a", title: "A", deletedAt: NOW, pinned: true, folder: "f1" },
      { id: "b", title: "B", deletedAt: NOW - DAY, archived: true },   // a malformed field is left out
    ]);
    // A chat put again keeps its first place, as it keeps its first date.
    assert.deepEqual(M.trashPut(list, "a", "A", NOW + DAY, { archived: true })[0], list[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ATO-2747: an entry written before the place fields still reads, with none of them", () => {
  assert.deepEqual(M.coerceTrash({ entries: [{ id: "old", title: "Old chat", deletedAt: NOW }] }),
    [{ id: "old", title: "Old chat", deletedAt: NOW }]);
  assert.deepEqual(M.coercePlace(null), {});
  assert.deepEqual(M.coercePlace({ id: "x", title: "y" }), {});
});

test("ATO-2747: Empty Trash counts what went and what stayed (Deleted 7 of 9)", async () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({ id: "s" + i, title: "", deletedAt: NOW - i }));
  const out = await M.emptyTrash(entries, async (id) => { if (id === "s3" || id === "s7") throw new Error("HTTP 503"); });
  assert.equal(out.total, 9);
  assert.equal(out.purged.length, 7);
  assert.equal(out.failed, 2);
  assert.deepEqual(out.entries.map((e) => e.id), ["s3", "s7"]);   // still in Trash
  assert.equal(out.detail, "HTTP 503");   // for the log only
  const all = await M.emptyTrash(entries, async () => {});
  assert.deepEqual([all.failed, all.total, all.entries.length, "detail" in all], [0, 9, 0, false]);
});

test("ATO-2747: Trash IPC answers in plain words, never the raw message, status or path", () => {
  const ipc = src("../main/chat-trash-ipc.ts");
  assert.doesNotMatch(ipc, /error: (refused|err\.message|requestErrorText)/, "no raw text in an answer");
  assert.doesNotMatch(ipc, /error: err instanceof Error/);
  for (const text of Object.values(M.TRASH_ERRORS)) {
    assert.doesNotMatch(text, /HTTP|\d{3}|\/|\\|ECONN|EACCES/, text);
    assert.doesNotMatch(text, /\u2014/);
  }
  assert.match(ipc, /console\.warn\(`\[desktop\] chat trash: \$\{kind\}: \$\{detail\}`\)/, "details go to the log");
  const empty = ipc.slice(ipc.indexOf('ipcMain.handle("chatTrash:empty"'));
  assert.match(empty, /failed: out\.failed, total: out\.total/);
  const restore = ipc.slice(ipc.indexOf('ipcMain.handle("chatTrash:restore"'), ipc.indexOf('ipcMain.handle("chatTrash:forget"'));
  assert.match(restore, /entry: before\.find/, "restore answers with where the chat sat");
  assert.match(ipc, /trashPut\(readTrash\(trashPath\(\)\), id, title, Date\.now\(\), coercePlace\(payload\)\)/);
  assert.match(src("../preload/preload.ts"), /ipcRenderer\.invoke\("chatTrash:put", \{ \.\.\.\(place \|\| \{\}\), id, title \}\)/);
});

test("stampTrashed tells the agent (POST /api/sessions/{id}/trashed) and reads its answer", async () => {
  const calls = [];
  const route = (status, body = null) => async (...args) => { calls.push(args); return { status, body }; };
  assert.equal(await M.stampTrashed(route(200), "s1", true), null);
  assert.deepEqual(calls[0], ["s1", "trashed", "POST", { trashed: true }]);
  assert.equal(await M.stampTrashed(route(200), "s1", false), null);
  assert.deepEqual(calls[1][3], { trashed: false });
  // A chat the agent does not hold, or an agent from before the route: nothing to hide, go ahead.
  assert.equal(await M.stampTrashed(route(404), "gone", true), null);
  assert.equal(await M.stampTrashed(route(500, { error: { message: "disk full" } }), "s1", true), "disk full");
  assert.equal(await M.stampTrashed(route(503), "s1", true), "HTTP 503");
  assert.equal(await M.stampTrashed(async () => { throw new Error("ECONNREFUSED"); }, "s1", true), "ECONNREFUSED");
});

test("wiring: put stamps the chat before it is listed in Trash, restore clears it before it leaves", () => {
  const ipc = src("../main/chat-trash-ipc.ts");
  const put = ipc.slice(ipc.indexOf('ipcMain.handle("chatTrash:put"'), ipc.indexOf('ipcMain.handle("chatTrash:restore"'));
  const restore = ipc.slice(ipc.indexOf('ipcMain.handle("chatTrash:restore"'), ipc.indexOf('ipcMain.handle("chatTrash:forget"'));
  assert.ok(put.includes("await stamp(id, true)") && put.indexOf("await stamp(id, true)") < put.indexOf("writeTrash("), "put stamps first");
  assert.match(put, /if \(refused\) return failed\("hide", refused\);/);
  assert.ok(restore.includes("await stamp(id, false)") && restore.indexOf("await stamp(id, false)") < restore.indexOf("writeTrash("), "restore clears first");
  assert.match(ipc, /client\.sessionRoute\(sid, path, method, body, 10_000\)/);
});

test("the renderer counts the days left down to zero", () => {
  assert.equal(R.trashDaysLeft(NOW, NOW), 30);
  assert.equal(R.trashDaysLeft(NOW - 29.5 * DAY, NOW), 1);
  assert.equal(R.trashDaysLeft(NOW - 31 * DAY, NOW), 0);
});

test("the Trash section: nothing while empty, folded with a count, open with Restore, Delete forever and Empty Trash", () => {
  assert.equal(R.trashSidebarHTML([], true, NOW, h), "");
  const entries = [{ id: "s1", title: "Plan the trip", deletedAt: NOW - 3 * DAY }];
  const folded = R.trashSidebarHTML(entries, false, NOW, h);
  assert.match(folded, /data-list="trash"/);
  assert.match(folded, /data-act="trash:toggle"/);
  assert.match(folded, /<span class="ct tnum">1<\/span>/);
  assert.doesNotMatch(folded, /trash:restore/);
  const open = R.trashSidebarHTML(entries, true, NOW, h);
  assert.match(open, /Plan the trip/);
  assert.match(open, /27 days left/);
  assert.match(open, /data-act="trash:restore:s1"/);
  assert.match(open, /data-act="trash:forgetask:s1"/);
  assert.match(open, /data-act="trash:emptyask"/);
  assert.doesNotMatch(open, /data-ses=/, "a chat in Trash is not a chat row that opens it");
});

test("chatTrashHide takes chats in Trash out of the session list, in place", () => {
  R.TRASH.entries = [{ id: "b", title: "B", deletedAt: NOW }];
  const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const same = list;
  R.chatTrashHide(list);
  assert.equal(list, same);
  assert.deepEqual(list.map((s) => s.id), ["a", "c"]);
  R.TRASH.entries = [];
});

/** chat-trash.js in a sandbox with the renderer globals it reads. */
function sandbox(bridge) {
  const c = {
    S: { alert: null }, SESSIONS: [{ id: "s1", t: "Plan the trip" }], BR: bridge,
    esc: h.esc, ic: h.ic, toasts: [], renders: 0,
    PREFS: { pinned: [], archived: [], seen: {} }, FOLDERS: { state: { folders: [{ id: "f1", name: "Work" }], chats: {}, auto: {} } },
    saves: { prefs: 0, folders: 0 },
  };
  c.archiveSet = (list, id, on) => { const rest = (list || []).filter((x) => x !== id); return on ? [id, ...rest] : rest; };
  c.folderById = (st, id) => st.folders.find((f) => f.id === id) || null;
  c.folderPut = (st, sid, fid) => { st.chats[sid] = fid; delete st.auto[sid]; return true; };
  c.savePrefs = () => { c.saves.prefs++; };
  c.saveFolders = () => { c.saves.folders++; };
  c.render = () => { c.renders++; };
  c.nameVisibleSessions = () => {};
  c.refreshSessions = async () => {};
  c.toast = (t, s, kind) => { c.toasts.push(t + " | " + (s || "") + (kind ? " | " + kind : "")); };
  vm.createContext(c);
  vm.runInContext(src("../renderer/chat-trash.js"), c);
  return c;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("Delete…'s confirm puts the chat in Trash through main, never the agent's DELETE", async () => {
  const calls = [];
  const c = sandbox({
    chatTrashPut: async (id, title) => { calls.push(["put", id, title]); return { ok: true, entry: { id, title, deletedAt: NOW } }; },
    deleteSession: async (id) => { calls.push(["delete", id]); return { ok: true }; },
  });
  const res = await vm.runInContext("chatTrashPut('s1')", c);
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [["put", "s1", "Plan the trip"]]);
  assert.deepEqual([...vm.runInContext("TRASH.entries.map((e) => e.id)", c)], ["s1"]);   // copied out of the vm realm: strict deepEqual compares prototypes
  // A chat this window does not list is not touched at all.
  const unknown = await vm.runInContext("chatTrashPut('nope')", c);
  assert.equal(unknown.ok, false);
  assert.equal(calls.length, 1);
});

test("Delete forever asks first; only its confirm reaches main", async () => {
  const calls = [];
  const c = sandbox({ chatTrashForget: async (id) => { calls.push(id); return { ok: true }; } });
  vm.runInContext("TRASH.entries = [{id: 's1', title: 'Plan the trip', deletedAt: 0}]", c);
  const close = () => { c.S.alert = null; };
  assert.equal(vm.runInContext("chatTrashAct", c)("trash", "forgetask:s1", close), true);
  assert.equal(c.S.alert.act, "trash:forget:s1");
  assert.match(c.S.alert.title, /forever/);
  assert.deepEqual(calls, []);
  vm.runInContext("chatTrashAct", c)("trash", "forget:s1", close);
  await tick();
  assert.deepEqual(calls, ["s1"]);
  assert.deepEqual(vm.runInContext("TRASH.entries", c).length, 0);
});

test("Restore takes the chat out of Trash and re-reads the list", async () => {
  const calls = [];
  const c = sandbox({ chatTrashRestore: async (id) => { calls.push(id); return { ok: true }; } });
  let reread = 0;
  c.refreshSessions = async () => { reread++; };
  vm.runInContext("TRASH.entries = [{id: 's1', title: 'Plan the trip', deletedAt: 0}]", c);
  vm.runInContext("chatTrashAct", c)("trash", "restore:s1", () => {});
  await tick(); await tick();
  assert.deepEqual(calls, ["s1"]);
  assert.equal(reread, 1);
  assert.equal(vm.runInContext("TRASH.entries.length", c), 0);
});

test("wiring: Delete… goes to Trash, Trash is hidden from the lists and drawn, the routes reach main", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /chatTrashPut\(v\)\.then\(\(res\) => \{/);
  assert.doesNotMatch(r, /BR\.deleteSession\(v\)\.then/, "the row's Delete no longer calls the agent's DELETE");
  assert.match(r, /ok:'Move to Trash', act:'del:' \+ v/);
  assert.match(r, /chatTrashHide\(SESSIONS\);/);
  assert.match(r, /archivedSidebarHTML\(ch\.archived\) \+ chatTrashSidebarHTML\(\)/);
  assert.match(r, /if \(chatTrashAct\(k, v, close\)\) return;/);
  assert.match(r, /\n  chatTrashLoad\(\);/);
  const html = src("../renderer/index.html");
  const at = html.indexOf('<script src="chat-trash.js"></script>');
  assert.ok(at > 0 && at < html.indexOf('<script src="renderer.js"></script>'), "loaded before renderer.js");
  assert.match(html, /href="css\/chat-trash\.css"/);
  const pre = src("../preload/preload.ts");
  for (const ch of ["chatTrash:list", "chatTrash:put", "chatTrash:restore", "chatTrash:forget", "chatTrash:empty"]) {
    assert.ok(pre.includes(`"${ch}"`), `preload sends ${ch}`);
    assert.ok(src("../main/chat-trash-ipc.ts").includes(`ipcMain.handle("${ch}"`), `main handles ${ch}`);
  }
  assert.match(src("../main/main.ts"), /\n  wireChatTrashIpc\(client\);/);
});
