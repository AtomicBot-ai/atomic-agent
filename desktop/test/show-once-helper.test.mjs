// ATO-2499 "Show once": the Accessibility helper (native/atomic-show-once.swift)
// and what its answers add to the step log. main/show-once-helper.ts (the line
// protocol, a fake child process), show-once-prober.ts (helper first, osascript
// when it is missing or stops) and show-once-log.ts (menu commands, window titles)
// against the built output.
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const H = require("../out/main/show-once-helper.js");
const PR = require("../out/main/show-once-prober.js");
const L = require("../out/main/show-once-log.js");
const S = require("../out/main/show-once-skill.js");
const here = fileURLToPath(new URL(".", import.meta.url));

const numbers = { name: "Numbers", bundleId: "com.apple.iWork.Numbers", pid: 100 };
const safari = { name: "Safari", bundleId: "com.apple.Safari", pid: 102 };

/** A child process that answers like the helper: `reply(line)` returns what it prints for each command. */
function fakeChild(reply, { ready = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.written = [];
  child.killed = false;
  child.stdin = {
    write(chunk) {
      child.written.push(chunk);
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const out = reply(line);
        if (out !== undefined) setImmediate(() => child.stdout.emit("data", `${JSON.stringify(out)}\n`));
      }
      return true;
    },
    end() {},
  };
  child.kill = () => { child.killed = true; child.emit("exit", 0); };
  setImmediate(() => child.stdout.emit("data", ready ? '{"ready":true}\n' : '{"untrusted":true}\n'));
  return child;
}

test("the line protocol: ready, untrusted, answers by id, window and menu pushes; anything else is nothing", () => {
  assert.deepEqual(H.parseShowOnceHelperLine('{"ready":true}'), { type: "ready" });
  assert.deepEqual(H.parseShowOnceHelperLine('{"untrusted":true}'), { type: "untrusted" });
  const a = H.parseShowOnceHelperLine(JSON.stringify({ id: 4, app: numbers, windowTitle: "Budget", element: { role: "AXSecureTextField", label: "hunter2" } }));
  assert.equal(a.type, "answer");
  assert.equal(a.id, 4);
  assert.equal(a.probe.windowTitle, "Budget");
  assert.deepEqual(a.probe.element, { role: "AXSecureTextField", label: "" }, "a password field never carries a label");
  assert.deepEqual(H.parseShowOnceHelperLine(JSON.stringify({ ev: "window", app: numbers, title: "Export" })),
    { type: "push", push: { kind: "window", app: numbers, title: "Export" } });
  assert.deepEqual(H.parseShowOnceHelperLine(JSON.stringify({ ev: "menu", app: numbers, path: ["File", 3, "", "Export To"] })),
    { type: "push", push: { kind: "menu", app: numbers, path: ["File", "Export To"] } });
  for (const bad of ["", "not json", "[1]", '{"ev":"menu","path":[]}', '{"id":"x"}']) assert.equal(H.parseShowOnceHelperLine(bad), null, bad);
});

test("the helper answers each question by its id and pushes what its observer hears", async () => {
  const pushes = [];
  let child;
  const h = new H.ShowOnceHelper({
    spawn: () => (child = fakeChild((line) => {
      const [kind, id] = line.split(" ");
      return kind === "click" ? { id: Number(id), app: numbers, windowTitle: "Budget" } : { id: Number(id), app: numbers, focused: { role: "AXTextField", label: "" } };
    })),
    onPush: (p) => pushes.push(p),
  });
  assert.equal(await h.start(), true);
  const [c, k] = await Promise.all([h.ask("click", 10.6, 20.2), h.ask("key")]);
  assert.equal(c.windowTitle, "Budget");
  assert.equal(k.focused.role, "AXTextField");
  assert.deepEqual(child.written, ["click 1 11 20\n", "key 2\n"]);
  child.stdout.emit("data", '{"ev":"menu","app":' + JSON.stringify(numbers) + ',"path":["File","Save"]}\n{"ev":"win');
  child.stdout.emit("data", 'dow","app":' + JSON.stringify(numbers) + ',"title":"Saved"}\n');
  assert.deepEqual(pushes.map((p) => p.kind), ["menu", "window"], "a line split across chunks is read whole");
  h.stop();
  assert.equal(child.killed, true);
  assert.equal(await h.ask("key"), null, "a stopped helper answers nothing");
});

test("a helper without Accessibility, or one that never answers, gives way to osascript", async () => {
  const untrusted = new H.ShowOnceHelper({ spawn: () => fakeChild(() => undefined, { ready: false }), onPush: () => {} });
  assert.equal(await untrusted.start(), false);
  const silent = new H.ShowOnceHelper({ spawn: () => fakeChild(() => undefined), onPush: () => {}, answerMs: 20 });
  assert.equal(await silent.start(), true);
  assert.equal(await silent.ask("click", 1, 1), null);
  silent.stop();
});

test("the prober asks the helper when the build has it, osascript when it does not or when it stops", async () => {
  const asked = [];
  const osascript = async (kind) => { asked.push(kind); return { app: safari, window: null, element: null, focused: null, windowTitle: null }; };
  const none = await PR.openShowOnceProber({ nativeDir: "/x", platform: "darwin", onPush: () => {}, exists: () => false, osascript });
  assert.equal(none.via, "osascript");
  assert.equal((await none.click(1, 2)).app.name, "Safari");
  await none.key(1000);
  await none.key(1500);
  assert.deepEqual(asked, ["click", "key"], "osascript's key answer is reused for a moment");
  none.forgetKey();
  await none.key(1600);
  assert.equal(asked.length, 3);

  let child;
  const spawned = [];
  const withHelper = await PR.openShowOnceProber({
    nativeDir: "/res/native", platform: "darwin", onPush: () => {}, exists: (p) => p === "/res/native/atomic-show-once", osascript,
    spawnHelper: (file) => { spawned.push(file); return (child = fakeChild((line) => ({ id: Number(line.split(" ")[1]), app: numbers }))); },
  });
  assert.deepEqual(spawned, ["/res/native/atomic-show-once"]);
  assert.equal(withHelper.via, "helper");
  assert.equal((await withHelper.click(5, 5)).app.name, "Numbers");
  child.emit("exit", 1); // the helper crashed mid-recording
  assert.equal((await withHelper.click(5, 5)).app.name, "Safari");
  assert.equal(withHelper.via, "osascript");
  const off = await PR.openShowOnceProber({ nativeDir: "/x", platform: "linux", onPush: () => {}, exists: () => true, osascript, spawnHelper: () => assert.fail("no resident helper on Linux") });
  assert.equal(off.via, "xdotool", "Linux asks xdotool per event");
});

const click = (app, extra = {}) => ({ kind: "click", at: 0, x: 10, y: 10, button: "left", clicks: 1, app, window: null, element: null, ...extra });
const key = (keycode, app, extra = {}) => ({ kind: "key", at: 0, keycode, meta: false, ctrl: false, alt: false, shift: false, app, ...extra });

test("a menu command replaces the clicks that opened the menu, or names what a shortcut ran", () => {
  const log = new L.ShowOnceLog(1);
  log.add(click(numbers, { at: 1, windowTitle: "Budget", element: { role: "AXButton", label: "Add Sheet" } }));
  log.add(click(numbers, { at: 2, windowTitle: "Budget", element: { role: "AXMenuBarItem", label: "File" } }));
  log.add(click(numbers, { at: 3, element: { role: "AXMenuItem", label: "Export To" } }));
  log.add({ kind: "menu", at: 4, app: numbers, path: ["File", "Export To", "PDF…"] });
  log.add(key(31, numbers, { at: 5000, meta: true, windowTitle: "Export Your Spreadsheet" }));
  log.add({ kind: "menu", at: 5300, app: numbers, path: ["File", "Save"] });
  log.add({ kind: "menu", at: 1, app: safari, path: ["History", "A page title"] });
  assert.deepEqual(log.steps.slice(1).map((s) => s.kind), ["click", "menu", "keys"]);
  assert.deepEqual(log.steps[2], { kind: "menu", app: "Numbers", bundleId: "com.apple.iWork.Numbers", path: ["File", "Export To", "PDF…"], window: "Budget", after: "Export Your Spreadsheet" });
  assert.deepEqual(log.steps[3].menu, ["File", "Save"]);
  assert.equal(log.actionCount, 3);
  const md = S.compileShowOnceSkill(log.steps, new Date(2026, 10, 28, 10, 0)).content;
  assert.ok(md.includes("Choose **File > Export To > PDF…** from the menu bar in Numbers."));
  assert.ok(md.includes("It runs the menu command **File > Save**."));
});

test("window titles: where a step happened and what came to the front after it; none from browsers", () => {
  const log = new L.ShowOnceLog(1);
  log.add(key(28, numbers, { windowTitle: "Budget" }));
  log.add({ kind: "window", at: 1, app: numbers, title: "Print" });
  log.add({ kind: "window", at: 2, app: numbers, title: "Budget" });
  assert.deepEqual(log.steps[1], { kind: "keys", app: "Numbers", bundleId: "com.apple.iWork.Numbers", keys: "return", window: "Budget" }, "back where it was: no after-state");
  log.add({ kind: "window", at: 3, app: numbers, title: "Print" });
  log.add(key(35, numbers, { windowTitle: "Print", focused: { role: "AXTextField", label: "Copies" } }));
  assert.equal(log.steps[1].after, "Print");
  assert.deepEqual(log.steps[2], { kind: "text", app: "Numbers", bundleId: "com.apple.iWork.Numbers", secure: false, into: "Copies", window: "Print" });
  log.add(click(safari, { windowTitle: "My bank: balance" }));
  log.add({ kind: "window", at: 4, app: safari, title: "Another page" });
  assert.equal(JSON.stringify(log.steps).includes("bank"), false, "a page title is the page's content");
  assert.equal(log.steps.at(-1).window, undefined);
});

test("the helper's source never reads a control's value and only listens", () => {
  const swift = readFileSync(join(here, "..", "native", "atomic-show-once.swift"), "utf8");
  assert.equal(/kAXValueAttribute|"AXValue"/.test(swift), false);
  assert.equal(/CGEvent\.post|AXUIElementPerformAction|CGEvent\(keyboardEventSource/.test(swift), false, "it posts no input");
  assert.ok(swift.includes('if role == "AXSecureTextField" { return ["role": role, "label": ""] }'));
});
