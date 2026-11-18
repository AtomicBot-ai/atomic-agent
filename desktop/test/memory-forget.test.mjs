// ATO-321: Settings › Memory › Clear old memory. The renderer half
// (renderer/memory-forget.js) runs in a vm with a fake bridge; main's half
// (main/memory-forget.ts) is checked against the built output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const F = require("../renderer/memory-forget.js");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const h = { esc, ic: (n) => '<i data-ic="' + n + '"></i>' };

test("dates: today in local time, real days only", () => {
  assert.equal(F.memForgetToday(new Date(2026, 10, 18, 23, 59).getTime()), "2026-11-18");
  assert.equal(F.memForgetToday(new Date(2026, 0, 5).getTime()), "2026-01-05");
  assert.ok(F.memForgetDateOk("2026-02-28"));
  for (const bad of ["2026-02-30", "2026-13-01", "18.11.2026", "", null]) assert.ok(!F.memForgetDateOk(bad), String(bad));
});

test("the confirm says how many, what goes, what stays, and that it cannot be undone", () => {
  assert.equal(F.memForgetConfirm({ notes: 0, lessons: 0 }, "2026-11-01"), null);
  const ask = F.memForgetConfirm({ notes: 12, lessons: 1 }, "2026-11-01");
  assert.equal(ask.title, "Clear memory from before 2026-11-01?");
  assert.match(ask.msg, /^12 notes and 1 lesson made before that day/);
  assert.match(ask.msg, /Profile\) stays/);
  assert.match(ask.msg, /cannot be undone/);
  assert.equal(ask.ok, "Clear 12 notes and 1 lesson");
  assert.ok(!ask.msg.includes("—") && !ask.title.includes("—"));
});

test("the card: closed draws nothing; open has the date, the button, then the confirm", () => {
  assert.equal(F.memForgetHTML({ open: false }, h), "");
  const open = F.memForgetHTML({ open: true, date: "2026-11-01", phase: "idle", counts: null, error: null }, h);
  assert.ok(open.includes('id="memf-date"') && open.includes('value="2026-11-01"') && open.includes('data-act="memory:forgetCheck"'));
  const confirm = F.memForgetHTML({ open: true, date: "2026-11-01", phase: "confirm", counts: { notes: 2, lessons: 0 }, error: null }, h);
  assert.ok(confirm.includes("data-memf-confirm") && confirm.includes('data-act="memory:forgetGo"') && confirm.includes('data-act="memory:forgetNo"'));
  const busy = F.memForgetHTML({ open: true, date: "2026-11-01", phase: "clearing", counts: { notes: 2, lessons: 0 }, error: null }, h);
  assert.match(busy, /memory:forgetCheck" disabled>/);
  assert.ok(F.memForgetHTML({ open: true, date: "2026-11-01", phase: "empty", counts: { notes: 0, lessons: 0 } }, h).includes("data-memf-empty"));
  assert.ok(F.memForgetHTML({ open: true, date: "x", phase: "idle", error: "Pick a day." }, h).includes("Pick a day."));
});

function load(answers) {
  const calls = [];
  const ctx = {
    console,
    renders: 0,
    refreshed: 0,
    BR: { memoryForget: async (before, apply) => { calls.push([before, apply]); return answers[apply ? "apply" : "check"]; } },
    document: { getElementById: (id) => (id === "memf-date" ? { value: ctx.dateField } : null), addEventListener: () => {} },
    dateField: "2026-11-01",
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../renderer/memory-forget.js", import.meta.url), "utf8"), ctx, { filename: "memory-forget.js" });
  vm.runInContext("render = () => { renders++; }; memRefresh = () => { refreshed++; };", ctx);
  return { ctx, calls, MEMF: vm.runInContext("MEMF", ctx), act: (v) => vm.runInContext("memForgetAct(" + JSON.stringify(v) + ")", ctx) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("flow: count first, confirm, then clear and refresh the list", async () => {
  const t = load({ check: { ok: true, applied: false, notes: 4, lessons: 2 }, apply: { ok: true, applied: true, notes: 4, lessons: 2 } });
  assert.equal(t.act("forget"), true);
  assert.equal(t.MEMF.open, true);
  t.act("forgetGo");
  assert.deepEqual(t.calls, [], "nothing is cleared before a count and a confirm");
  t.act("forgetCheck");
  await settle();
  assert.deepEqual(t.calls, [["2026-11-01", false]]);
  assert.equal(t.MEMF.phase, "confirm");
  t.act("forgetGo");
  await settle();
  assert.deepEqual(t.calls, [["2026-11-01", false], ["2026-11-01", true]]);
  assert.equal(t.MEMF.phase, "done");
  assert.equal(t.ctx.refreshed, 1);
});

test("flow: Cancel clears nothing; nothing to clear says so; a bad date or a failure is said", async () => {
  let t = load({ check: { ok: true, applied: false, notes: 3, lessons: 0 } });
  t.act("forget"); t.act("forgetCheck"); await settle();
  t.act("forgetNo");
  assert.equal(t.MEMF.phase, "idle");
  t.act("forgetGo"); await settle();
  assert.equal(t.calls.length, 1, "no clear after Cancel");

  t = load({ check: { ok: true, applied: false, notes: 0, lessons: 0 } });
  t.act("forget"); t.act("forgetCheck"); await settle();
  assert.equal(t.MEMF.phase, "empty");

  t = load({});
  t.ctx.dateField = "";
  t.act("forget"); t.act("forgetCheck"); await settle();
  assert.equal(t.MEMF.error, "Pick a day.");
  assert.equal(t.calls.length, 0);

  t = load({ check: { ok: false, error: "This agent version cannot clear memory by date yet. Update the agent, then try again." } });
  t.act("forget"); t.act("forgetCheck"); await settle();
  assert.match(t.MEMF.error, /Update the agent/);
});

test("renderer wiring: toolbar button, card, verbs, and load order", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.ok(src.includes("memForgetButtonHTML({ic})"));
  assert.ok(src.includes("memForgetHTML(MEMF, {esc, ic})"));
  assert.ok(src.includes("if (memForgetAct(verb)) return;"));
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at("memory-forget.js") > 0 && at("memory-forget.js") < at("renderer.js"));
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.ok(preload.includes('ipcRenderer.invoke("cli:memoryForget", { before, apply: apply === true })'));
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.ok(main.includes("registerMemoryForgetIpc({ ipcMain, run: (args, timeoutMs) => atagRun(args, timeoutMs), remote: () => client.isRemote })"));
});

// main/memory-forget.ts, against the built output.
let M = null;
try { M = require("../out/main/memory-forget.js"); } catch { M = null; }

test("main: runs the agent's command, dry run first, --yes only to apply", { skip: !M && "run npm run build first" }, async () => {
  const seen = [];
  const run = async (args) => {
    seen.push(args);
    return args.includes("--yes")
      ? { ok: true, stdout: "deleted 4 notes, deprecated 2 lessons created before 2026-11-01\n", stderr: "" }
      : { ok: true, stdout: "would delete 4 notes and deprecate 2 lessons created before 2026-11-01; rerun with --yes to do it\n", stderr: "" };
  };
  assert.deepEqual(await M.memoryForget(run, false, { before: "2026-11-01", apply: false }), { ok: true, applied: false, notes: 4, lessons: 2 });
  assert.deepEqual(await M.memoryForget(run, false, { before: "2026-11-01", apply: true }), { ok: true, applied: true, notes: 4, lessons: 2 });
  assert.deepEqual(seen, [["memory", "forget", "--before", "2026-11-01"], ["memory", "forget", "--before", "2026-11-01", "--yes"]]);
});

test("main: a bad date, a remote agent, an old agent, a failure", { skip: !M && "run npm run build first" }, async () => {
  const never = async () => { throw new Error("must not run"); };
  assert.equal((await M.memoryForget(never, false, { before: "2026-02-30", apply: true })).ok, false);
  assert.equal((await M.memoryForget(never, false, { before: "--yes", apply: true })).ok, false);
  assert.match((await M.memoryForget(never, true, { before: "2026-11-01" })).error, /another computer/);
  const old = async () => ({ ok: false, stdout: "", stderr: "unknown subcommand: forget\natomic-agent memory …\n" });
  assert.match((await M.memoryForget(old, false, { before: "2026-11-01" })).error, /cannot clear memory by date yet/);
  const fail = async () => ({ ok: false, stdout: "", stderr: "memory forget failed: database is locked\n" });
  assert.equal((await M.memoryForget(fail, false, { before: "2026-11-01" })).error, "Could not clear memory: memory forget failed: database is locked");
});
