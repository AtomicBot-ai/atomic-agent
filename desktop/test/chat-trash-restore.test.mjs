// Unit tests for ATO-2747 (Trash keeps where a chat sat, Undo, failure
// states): the renderer half of renderer/chat-trash.js run in a sandbox, and
// the toast action wiring read from the sources. The store half is in
// test/chat-trash.test.mjs.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const R = require("../renderer/chat-trash.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

const NOW = Date.UTC(2026, 10, 27, 12);
const h = { esc: (s) => String(s).replace(/"/g, "&quot;"), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };

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

test("ATO-2747: Delete… sends where the chat sat; Restore puts it back (folder only if it still exists)", async () => {
  const calls = [];
  const c = sandbox({
    chatTrashPut: async (id, title, place) => { calls.push(JSON.parse(JSON.stringify(place))); return { ok: true, entry: { id, title, deletedAt: NOW, ...place } }; },
    chatTrashRestore: async (id) => ({ ok: true, entry: vm.runInContext("TRASH.entries", c).find((e) => e.id === id) }),
  });
  c.PREFS.pinned = ["s1"]; c.PREFS.archived = ["s1"]; c.FOLDERS.state.chats.s1 = "f1";
  await vm.runInContext("chatTrashPut('s1')", c);
  assert.deepEqual(calls, [{ pinned: true, archived: true, folder: "f1" }]);
  // What renderer.js's del: branch does after the put.
  c.PREFS.pinned = []; c.PREFS.archived = []; delete c.FOLDERS.state.chats.s1;
  vm.runInContext("chatTrashAct", c)("trash", "restore:s1", () => {});
  await tick(); await tick(); await tick();
  assert.deepEqual([...c.PREFS.pinned], ["s1"]);
  assert.deepEqual([...c.PREFS.archived], ["s1"]);
  assert.equal(c.FOLDERS.state.chats.s1, "f1");
  assert.deepEqual(c.saves, { prefs: 1, folders: 1 });
  assert.deepEqual(c.toasts, ["Chat restored | Plan the trip"]);
});

test("ATO-2747: an old entry, or one whose folder is gone, still restores to the main list", () => {
  const R2 = R;
  const helpers = {
    archiveSet: (list, id, on) => (on ? [id, ...(list || [])] : list),
    folderById: (st, id) => st.folders.find((f) => f.id === id) || null,
    folderPut: () => { throw new Error("must not file into a folder that is gone"); },
  };
  const prefs = { pinned: [], archived: [] };
  const folders = { folders: [], chats: {}, auto: {} };
  assert.deepEqual(R2.trashPutBack("old", { id: "old", title: "Old", deletedAt: NOW }, prefs, folders, helpers), { prefs: false, folders: false });
  assert.deepEqual(R2.trashPutBack("s1", { folder: "f-deleted" }, prefs, folders, helpers), { prefs: false, folders: false });
  assert.deepEqual([prefs.pinned, prefs.archived, folders.chats], [[], [], {}]);
  assert.deepEqual(R2.trashPlaceOf("x", { pinned: ["y"], archived: [] }, { chats: {} }), {});
});

test("ATO-2747: Restore of a chat deleted meanwhile says it could not, in red", async () => {
  const c = sandbox({ chatTrashRestore: async () => ({ ok: true, entry: null }) });
  c.SESSIONS = [];
  vm.runInContext("TRASH.entries = [{id: 's1', title: 'Plan the trip', deletedAt: 0, pinned: true}]", c);
  vm.runInContext("chatTrashAct", c)("trash", "restore:s1", () => {});
  await tick(); await tick(); await tick();
  assert.equal(c.toasts.length, 1);
  assert.match(c.toasts[0], /^Could not restore the chat \| .+ \| bad$/);
  assert.doesNotMatch(c.toasts[0], /Chat restored/);
  assert.deepEqual([...c.PREFS.pinned], [], "nothing is pinned for a chat that is gone");
});

test("ATO-2747: every Trash failure toast is red", async () => {
  const c = sandbox({
    chatTrashRestore: async () => ({ ok: false, error: "The agent could not bring this chat back right now. Try again in a moment." }),
    chatTrashForget: async () => { throw new Error("ipc gone"); },
    chatTrashEmpty: async () => ({ ok: false, error: "x", purged: [], failed: 2, total: 2 }),
  });
  vm.runInContext("TRASH.entries = [{id: 's1', title: 'A', deletedAt: 0}, {id: 's2', title: 'B', deletedAt: 0}]", c);
  const go = vm.runInContext("chatTrashAct", c);
  go("trash", "restore:s1", () => {}); await tick(); await tick();
  go("trash", "forget:s1", () => {}); await tick(); await tick();
  go("trash", "empty", () => {}); await tick(); await tick();
  assert.equal(c.toasts.length, 3);
  for (const t of c.toasts) assert.match(t, /\| bad$/, t);
  assert.doesNotMatch(c.toasts.join("\n"), /ipc gone/);
});

test("ATO-2747: Empty Trash shows it is busy and says Deleted 7 of 9 when only some went", async () => {
  let finish;
  const c = sandbox({ chatTrashEmpty: () => new Promise((r) => { finish = r; }) });
  vm.runInContext("TRASH.open = true; TRASH.entries = Array.from({length: 9}, (_, i) => ({id: 's' + i, title: 'T' + i, deletedAt: 0}))", c);
  const go = vm.runInContext("chatTrashAct", c);
  go("trash", "empty", () => {});
  assert.equal(vm.runInContext("TRASH.emptying", c), true);
  const busy = vm.runInContext("chatTrashSidebarHTML()", c);
  assert.match(busy, /disabled aria-busy="true">Emptying…</);
  assert.doesNotMatch(busy, /data-act="trash:emptyask"/);
  go("trash", "emptyask", () => {});   // a second press while busy asks nothing
  assert.equal(c.S.alert, null);
  finish({ ok: false, error: "e", purged: ["s0", "s1", "s2", "s4", "s5", "s6", "s8"], failed: 2, total: 9 });
  await tick(); await tick();
  assert.equal(vm.runInContext("TRASH.emptying", c), false);
  assert.deepEqual([...vm.runInContext("TRASH.entries.map((e) => e.id)", c)], ["s3", "s7"]);
  assert.match(c.toasts[0], /^Deleted 7 of 9 chats \| 2 chats are still in Trash\..* \| bad$/);
  assert.deepEqual([...R.trashEmptyToast({ ok: true, purged: ["a"], failed: 0, total: 1 })], ["Trash emptied", "1 chat deleted forever", ""]);
  assert.equal(R.trashEmptyToast(null)[2], "bad");
});

test("ATO-2747: Delete forever is a trash icon with its label, not an x", () => {
  const row = R.trashRowHTML({ id: "s1", title: "Plan", deletedAt: NOW }, NOW, h);
  const forever = row.slice(row.indexOf('data-act="trash:forgetask:s1"'));
  assert.match(forever, /title="Delete forever"/);
  assert.match(forever, /data-ic="trash"/);
  assert.doesNotMatch(forever, /data-ic="x"/);
});

test("ATO-2747 wiring: Moved to Trash has Undo, toasts carry an action, the move failure is red", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /toast\('Moved to Trash', gone, '', \{label: 'Undo', act: 'trash:restore:' \+ v\}\)/);
  assert.match(r, /toast\('Could not move the chat to Trash', \(res && res\.error\) \|\| '', 'bad'\)/);
  assert.match(r, /function toast\(t, s, kind, action\) \{/);
  assert.match(r, /S\.toasts\.push\(\{id, t, s, kind, action\}\)/);
  assert.match(r, /data-act="toastact:' \+ t\.id \+ '">' \+ esc\(t\.action\.label\)/);
  assert.match(r, /if \(k === 'toastact'\) \{[^\n]*if \(t && t\.action\) act\(t\.action\.act\); return; \}/);
  assert.match(src("../renderer/css/overlays.css"), /\.toast \.toast-act\{/);
});
