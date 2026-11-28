// Unit tests for ATO-2474: a chat in Trash opens read only, and the window's
// Trash follows the agent's mark (renderer/chat-trash-view.js), plus the
// wiring read from the sources.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const V = require("../renderer/chat-trash-view.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const h = { esc: (s) => String(s).replace(/"/g, "&quot;"), ic: (n) => "<svg data-ic=\"" + n + "\"></svg>" };

test("a chat is read only while it is in Trash, or opened from it and not back on the list", () => {
  const entries = [{ id: "t1", title: "T", deletedAt: 1 }];
  assert.equal(V.chatTrashViewingOf("t1", entries, new Set(), []), true);
  assert.equal(V.chatTrashViewingOf("s1", entries, new Set(), [{ id: "s1" }]), false);
  assert.equal(V.chatTrashViewingOf("gone", [], new Set(["gone"]), []), true, "deleted for good while open");
  assert.equal(V.chatTrashViewingOf("back", [], new Set(["back"]), [{ id: "back" }]), false, "restored and listed again");
  assert.equal(V.chatTrashViewingOf("", entries, new Set(), []), false);
});

test("the read-only line offers Restore only for a chat still in Trash", () => {
  const inTrash = V.trashReadOnlyHTML("t1", true, h);
  assert.match(inTrash, /This chat is in Trash\. Restore it to keep chatting\./);
  assert.match(inTrash, /data-act="trash:restore:t1"/);
  assert.doesNotMatch(inTrash, /<textarea/);
  const gone = V.trashReadOnlyHTML("t1", false, h);
  assert.doesNotMatch(gone, /trash:restore/);
  assert.doesNotMatch(gone, /—/);
});

test("the agent and the window disagree when a row's trashed differs from Trash; an older agent never does", () => {
  const entries = [{ id: "a", deletedAt: 1 }];
  assert.equal(V.trashAgentMismatch([{ id: "a", trashed: true }, { id: "b", trashed: false }], entries), false);
  assert.equal(V.trashAgentMismatch([{ id: "a", trashed: false }], entries), true, "restored in the terminal");
  assert.equal(V.trashAgentMismatch([{ id: "b", trashed: true }], entries), true, "trashed elsewhere");
  assert.equal(V.trashAgentMismatch([{ id: "a" }, { id: "b" }], entries), false);
});

function sandbox() {
  const c = vm.createContext({
    module: undefined, opened: [], loads: 0, refreshes: 0, toasts: [],
    S: { sessionId: "" }, SESSIONS: [], BR: null,
    esc: h.esc, ic: h.ic, render() {}, nameVisibleSessions() {},
    toast(t) { c.toasts.push(t); },
    openSession(id) { c.opened.push(id); },
    refreshSessions() { c.refreshes++; return Promise.resolve(); },
  });
  vm.runInContext(src("../renderer/chat-trash.js"), c);
  vm.runInContext(src("../renderer/chat-trash-view.js"), c);
  vm.runInContext("chatTrashLoad = () => { loads++; TRASH.entries = TRASH.entries.filter((e) => e.id !== 'a'); return Promise.resolve(); };", c);
  return c;
}

test("trashview:<id> opens a chat that is in Trash and nothing else", () => {
  const c = sandbox();
  vm.runInContext("TRASH.entries = [{id:'t1', title:'T', deletedAt:1}]", c);
  let closed = 0;
  assert.equal(vm.runInContext("chatTrashViewAct", c)("trashview", "t1", () => closed++), true);
  assert.deepEqual([...c.opened], ["t1"]);
  assert.equal(closed, 1);
  assert.equal(vm.runInContext("chatTrashViewAct", c)("trashview", "nope", () => closed++), true);
  assert.deepEqual([...c.opened], ["t1"]);
  assert.equal(vm.runInContext("chatTrashViewAct", c)("ses", "t1", () => closed++), false);
});

test("while a chat in Trash is open the composer is the read-only line and submit holds", () => {
  const c = sandbox();
  vm.runInContext("TRASH.entries = [{id:'t1', title:'T', deletedAt:1}]; S.sessionId = 't1';", c);
  assert.equal(vm.runInContext("chatTrashViewing()", c), true);
  assert.match(vm.runInContext("chatTrashComposerHTML()", c), /trash:restore:t1/);
  assert.equal(vm.runInContext("chatTrashHoldsSend()", c), true);
  assert.deepEqual([...c.toasts], ["This chat is in Trash"]);
  vm.runInContext("S.sessionId = 's2'", c);
  assert.equal(vm.runInContext("chatTrashHoldsSend()", c), false);
});

test("follow: an agent-trashed row leaves the list now; a mismatch reads Trash again and refreshes for a chat restored elsewhere", async () => {
  const c = sandbox();
  vm.runInContext("TRASH.loaded = true; TRASH.entries = [{id:'a', title:'A', deletedAt:1}]", c);
  const list = vm.runInContext("[{id:'a', trashed:false}, {id:'b', trashed:true}, {id:'c', trashed:false}]", c);
  vm.runInContext("chatTrashFollowAgent", c)(list);
  assert.deepEqual([...list.map((s) => s.id)], ["a", "c"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.loads, 1);
  assert.equal(c.refreshes, 1, "a was dropped from Trash, so the list is read again");
  vm.runInContext("chatTrashFollowAgent", c)(vm.runInContext("[{id:'b', trashed:true}]", c));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.loads, 1, "at most one read of Trash every 15 seconds");
});

test("wiring: the hooks sit in renderer.js, chat-trash.js and index.html", () => {
  const r = src("../renderer/renderer.js");
  assert.match(r, /trashed:typeof x\.trashed === 'boolean' \? x\.trashed : undefined,/);
  assert.match(r, /if \(typeof chatTrashFollowAgent === 'function'\) chatTrashFollowAgent\(SESSIONS\);[^\n]*\n  chatTrashHide\(SESSIONS\);/);
  assert.match(r, /if \(typeof chatTrashViewAct === 'function' && chatTrashViewAct\(k, v, close\)\) return;/);
  assert.match(r, /function composer\(\) \{\n  if \(typeof chatTrashViewing === 'function' && chatTrashViewing\(\)\) return chatTrashComposerHTML\(\);/);
  assert.match(r, /if \(typeof chatTrashHoldsSend === 'function' && chatTrashHoldsSend\(\)\) return;/);
  assert.match(src("../renderer/chat-trash.js"), /data-act="trashview:' \+ h\.esc\(e\.id\) \+ '"/);
  const html = src("../renderer/index.html");
  const trash = html.indexOf('<script src="chat-trash.js"></script>');
  const view = html.indexOf('<script src="chat-trash-view.js"></script>');
  assert.ok(trash > 0 && view > trash && view < html.indexOf('<script src="renderer.js"></script>'), "after chat-trash.js, before renderer.js");
  assert.match(html, /href="css\/chat-trash-view\.css"/);
});
