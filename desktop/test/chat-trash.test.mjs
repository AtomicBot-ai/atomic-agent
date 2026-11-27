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
  };
  c.render = () => { c.renders++; };
  c.nameVisibleSessions = () => {};
  c.refreshSessions = async () => {};
  c.toast = (t, s) => { c.toasts.push(t + " | " + (s || "")); };
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
  assert.deepEqual(vm.runInContext("TRASH.entries.map((e) => e.id)", c), ["s1"]);
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
