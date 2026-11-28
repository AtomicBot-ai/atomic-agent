// ATO-2754: Edit project's worktree list (renderer/chat-worktree.js). Remove
// asks first, says "Removing…" while main works, and a list that could not be
// read says so with Try again instead of "None". Runs the renderer file in a
// vm with the globals it reads from renderer.js; no build needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SRC = readFileSync(new URL("../renderer/chat-worktree.js", import.meta.url), "utf8");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function load(api) {
  const toasts = [];
  let redraws = 0;
  const ctx = vm.createContext({
    BR: { worktreeNewChat: async () => ({ ok: true }), ...api },
    esc, ic: (n) => "<i data-ic=\"" + n + "\"></i>",
    toast: (...a) => toasts.push(a), S: { overlay: "pedit", log: [] }, PROJECTS: {},
    projectEditRedraw: () => { redraws++; }, render: () => {}, act: () => {},
    console,
  });
  vm.runInContext(SRC, ctx, { filename: "chat-worktree.js" });
  return { run: (code) => vm.runInContext(code, ctx), toasts, redraws: () => redraws };
}

const ROWS = [{ path: "/s/wt/r-1/aa", branch: "atomic/session-aa", removable: true }];

test("Remove asks first; Cancel removes nothing", async () => {
  const removed = [];
  const t = load({ worktreeList: async () => ({ ok: true, rows: ROWS }), worktreeRemove: async (...a) => { removed.push(a); return { ok: true }; } });
  await t.run("worktreeLoad('p1')");
  assert.match(t.run("worktreeListHTML('p1')"), /data-act="pwtrm:0"[^>]*>Remove</);
  t.run("worktreeAct('pwtrm', '0')");
  assert.deepEqual(removed, [], "the first click only asks");
  const ask = t.run("worktreeListHTML('p1')");
  assert.match(ask, /data-wt-confirm/);
  assert.match(ask, /Remove atomic\/session-aa\?/);
  assert.match(ask, /data-act="pwtrm:no">Cancel</);
  assert.match(ask, /class="btn btn-danger sm" data-act="pwtrm:go:0">Remove</);
  t.run("worktreeAct('pwtrm', 'no')");
  assert.doesNotMatch(t.run("worktreeListHTML('p1')"), /data-wt-confirm/);
  assert.deepEqual(removed, []);
});

test("Remove once confirmed says Removing… until main answers, then reads the list again", async () => {
  let finish;
  const removed = [];
  let lists = 0;
  const t = load({
    worktreeList: async () => { lists++; return { ok: true, rows: lists === 1 ? ROWS : [] }; },
    worktreeRemove: (...a) => { removed.push(a); return new Promise((r) => { finish = r; }); },
  });
  await t.run("worktreeLoad('p1')");
  t.run("worktreeAct('pwtrm', '0')");
  t.run("globalThis.pending = worktreeRemove(BR, 'p1', 0)");
  assert.deepEqual(JSON.parse(JSON.stringify(removed)), [["p1", "/s/wt/r-1/aa"]]);
  const busy = t.run("worktreeListHTML('p1')");
  assert.match(busy, /aria-busy="true"><span class="tk-spin"><\/span>Removing…</);
  assert.doesNotMatch(busy, /data-wt-confirm/, "the question is gone while it works");
  t.run("worktreeAct('pwtrm', 'go:0')");
  assert.equal(removed.length, 1, "a second click while busy does nothing");
  finish({ ok: true });
  await t.run("pending");
  assert.equal(t.run("WT.busy"), false);
  assert.match(t.run("worktreeListHTML('p1')"), /None\./);
  assert.equal(t.toasts[0][0], "Worktree removed");
});

test("a list that could not be read says so, with Try again; never \"None\"", async () => {
  let fail = true;
  const t = load({ worktreeList: async () => { if (fail) throw new Error("ipc down"); return { ok: true, rows: ROWS }; }, worktreeRemove: async () => ({ ok: true }) });
  await t.run("worktreeLoad('p1')");
  const html = t.run("worktreeListHTML('p1')");
  assert.match(html, /Could not load this project’s worktrees\./);
  assert.match(html, /data-act="pwtrm:retry">Try again</);
  assert.doesNotMatch(html, /None\./);
  assert.doesNotMatch(html, /ipc down/, "no raw error text");
  // An answer that is not ok is the same.
  const t2 = load({ worktreeList: async () => ({ ok: false, error: "x" }) });
  await t2.run("worktreeLoad('p1')");
  assert.match(t2.run("worktreeListHTML('p1')"), /data-wt-failed/);
  // Try again reads it again.
  fail = false;
  t.run("worktreeAct('pwtrm', 'retry')");
  assert.match(t.run("worktreeListHTML('p1')"), /Looking/);
  await t.run("worktreeLoad('p1')");
  assert.match(t.run("worktreeListHTML('p1')"), /atomic\/session-aa/);
});

test("a worktree with work cannot be asked about or removed", async () => {
  const t = load({ worktreeList: async () => ({ ok: true, rows: [{ path: "/s/wt/x", branch: "b", removable: false, reason: "has changes nobody committed" }] }), worktreeRemove: async () => ({ ok: true }) });
  await t.run("worktreeLoad('p1')");
  t.run("worktreeAct('pwtrm', '0')");
  assert.doesNotMatch(t.run("worktreeListHTML('p1')"), /data-wt-confirm/);
  assert.match(t.run("worktreeListHTML('p1')"), /data-act="pwtrm:0" disabled/);
});
