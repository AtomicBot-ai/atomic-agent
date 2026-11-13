// Unit tests for main/quick-entry.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-523: the global hotkey and its one-line box. The accelerator check,
// the saved preference, register / unregister with the "taken" answer, and
// where the box opens on the display under the cursor.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Q = require("../out/main/quick-entry.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "qe-")); dirs.push(d); return d; };

test("the default combo is CommandOrControl+Shift+Space and passes its own check", () => {
  assert.equal(Q.QUICK_ENTRY_DEFAULT_ACCELERATOR, "CommandOrControl+Shift+Space");
  assert.deepEqual(Q.normalizeAccelerator(Q.QUICK_ENTRY_DEFAULT_ACCELERATOR), { ok: true, accelerator: "CommandOrControl+Shift+Space" });
});

test("a combo is written one way: modifier aliases, order, key case", () => {
  assert.equal(Q.normalizeAccelerator("shift+cmdorctrl+space").accelerator, "CommandOrControl+Shift+Space");
  assert.equal(Q.normalizeAccelerator("Option+Cmd+k").accelerator, "Command+Alt+K");
  assert.equal(Q.normalizeAccelerator(" ctrl + alt + f13 ").accelerator, "Control+Alt+F13");
  assert.equal(Q.normalizeAccelerator("Meta+Enter").accelerator, "Super+Return");
  assert.equal(Q.normalizeAccelerator("Ctrl+/").accelerator, "Control+/");
  assert.equal(Q.normalizeAccelerator("Ctrl++").accelerator, "Control+Plus");
  assert.equal(Q.normalizeAccelerator("Alt+num5").accelerator, "Alt+num5");
});

test("a global combo needs a real modifier and exactly one key", () => {
  for (const bad of ["", "   ", "Space", "Shift+A", "Escape", "Ctrl+Shift", "Ctrl+A+B", "Ctrl+Banana", "Ctrl++A", "Ctrl+", "CommandOrControl+Command+K", null, 42]) {
    const r = Q.normalizeAccelerator(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.equal(typeof r.error, "string");
  }
});

test("labels: symbols on a Mac, words elsewhere", () => {
  assert.equal(Q.acceleratorLabel("CommandOrControl+Shift+Space", "darwin"), "⌘⇧Space");
  assert.equal(Q.acceleratorLabel("CommandOrControl+Shift+Space", "win32"), "Ctrl+Shift+Space");
  assert.equal(Q.acceleratorLabel("Control+Alt+K", "linux"), "Ctrl+Alt+K");
  assert.equal(Q.acceleratorLabel("Command+Alt+Return", "darwin"), "⌘⌥↩");
});

test("the pref file: defaults for missing, corrupt or wrong parts; a round trip keeps both fields", () => {
  assert.deepEqual(Q.parseQuickEntryPref(null), { enabled: true, accelerator: "CommandOrControl+Shift+Space" });
  assert.deepEqual(Q.parseQuickEntryPref("{not json"), { enabled: true, accelerator: "CommandOrControl+Shift+Space" });
  assert.deepEqual(Q.parseQuickEntryPref('{"enabled":"yes","accelerator":"Shift+A"}'), { enabled: true, accelerator: "CommandOrControl+Shift+Space" });
  assert.deepEqual(Q.parseQuickEntryPref('{"enabled":false,"accelerator":"alt+space"}'), { enabled: false, accelerator: "Alt+Space" });

  const dir = tmp();
  assert.deepEqual(Q.readQuickEntryPref(dir), { enabled: true, accelerator: "CommandOrControl+Shift+Space" });
  assert.equal(Q.writeQuickEntryPref(dir, { enabled: false, accelerator: "Control+Alt+K" }), true);
  assert.deepEqual(Q.readQuickEntryPref(dir), { enabled: false, accelerator: "Control+Alt+K" });
  assert.deepEqual(JSON.parse(readFileSync(Q.quickEntryPrefPath(dir), "utf8")), { enabled: false, accelerator: "Control+Alt+K" });
  writeFileSync(Q.quickEntryPrefPath(dir), "garbage");
  assert.equal(Q.readQuickEntryPref(dir).enabled, true);
  assert.equal(Q.writeQuickEntryPref(join(dir, "missing", "dir"), Q.QUICK_ENTRY_DEFAULT_PREF), false, "never throws");
});

test("a Settings write is checked before it is merged", () => {
  const cur = { enabled: true, accelerator: "CommandOrControl+Shift+Space" };
  assert.deepEqual(Q.mergeQuickEntryPref(cur, { enabled: false }), { ok: true, pref: { enabled: false, accelerator: "CommandOrControl+Shift+Space" } });
  assert.deepEqual(Q.mergeQuickEntryPref(cur, { accelerator: "alt+k" }), { ok: true, pref: { enabled: true, accelerator: "Alt+K" } });
  assert.equal(Q.mergeQuickEntryPref(cur, { accelerator: "Shift+K" }).ok, false);
  assert.equal(Q.mergeQuickEntryPref(cur, { enabled: "no" }).ok, false);
  assert.equal(Q.mergeQuickEntryPref(cur, null).ok, false);
  assert.deepEqual(cur, { enabled: true, accelerator: "CommandOrControl+Shift+Space" }, "the current pref is not changed in place");
});

/** A globalShortcut stand-in: `others` are combos another app holds. */
function fakeHost(others = []) {
  const held = new Map();
  const calls = [];
  return {
    held, calls,
    register(acc, cb) { calls.push(["register", acc]); if (others.includes(acc)) return false; held.set(acc, cb); return true; },
    unregister(acc) { calls.push(["unregister", acc]); held.delete(acc); },
    isRegistered(acc) { return held.has(acc); },
  };
}

test("register: the combo is taken and pressing it opens the box", () => {
  const host = fakeHost();
  let pressed = 0;
  const s = new Q.QuickEntryShortcut(host, () => { pressed++; });
  assert.deepEqual(s.apply(Q.QUICK_ENTRY_DEFAULT_PREF), { state: "registered", accelerator: "CommandOrControl+Shift+Space" });
  host.held.get("CommandOrControl+Shift+Space")();
  assert.equal(pressed, 1);
  assert.equal(Q.quickEntryStateLine(s.state()), null);
});

test("a combo another app holds comes back as taken, with the sentence Settings shows", () => {
  const host = fakeHost(["CommandOrControl+Shift+Space"]);
  const s = new Q.QuickEntryShortcut(host, () => {});
  assert.deepEqual(s.apply(Q.QUICK_ENTRY_DEFAULT_PREF), { state: "taken", accelerator: "CommandOrControl+Shift+Space" });
  assert.equal(Q.quickEntryStateLine(s.state()), Q.SHORTCUT_TAKEN_MESSAGE);
  assert.match(Q.SHORTCUT_TAKEN_MESSAGE, /taken by another app/);
});

test("mock register -> false: Settings shows the message and no binding is stored", () => {
  const { quickEntryRowHTML } = require("../renderer/quick-entry-settings.js");
  const dir = tmp();
  const saved = { enabled: true, accelerator: "CommandOrControl+Shift+Space" };
  assert.equal(Q.writeQuickEntryPref(dir, saved), true);
  const host = fakeHost();
  host.register = (acc, cb) => { host.calls.push(["register", acc]); if (acc === "Control+Alt+K") return false; host.held.set(acc, cb); return true; };
  const s = new Q.QuickEntryShortcut(host, () => {});
  assert.equal(s.apply(saved).state, "registered");
  let writes = 0;
  const save = (p) => { writes++; return Q.writeQuickEntryPref(dir, p); };

  const out = Q.settleQuickEntrySet(saved, { accelerator: "Ctrl+Alt+K", enabled: true }, s, save);
  assert.equal(out.ok, false);
  assert.equal(out.error, Q.SHORTCUT_TAKEN_MESSAGE);
  assert.equal(writes, 0, "nothing is written for a combo that did not take");
  assert.deepEqual(Q.readQuickEntryPref(dir), saved, "the stored binding is still the old one");
  assert.deepEqual(out.pref, saved);
  assert.equal(host.held.has("Control+Alt+K"), false, "the taken combo is not held");
  assert.equal(host.held.has("CommandOrControl+Shift+Space"), true, "the old combo is back in force");
  assert.equal(out.pref.enabled, true, "it stays on");

  // What Settings draws from that answer.
  const html = quickEntryRowHTML({ info: { ok: false, enabled: true, label: "⌘⇧Space", error: out.error }, busy: false, recording: false, error: out.error },
    { esc: (t) => String(t), setSwitchHTML: () => "" });
  assert.match(html, /tk-help--warn[^>]*>This shortcut is taken by another app\. Choose another one\./);
});

test("at launch a default combo another app holds: unbound, still on, the line shows", () => {
  const host = fakeHost(["CommandOrControl+Shift+Space"]);
  const s = new Q.QuickEntryShortcut(host, () => {});
  const st = s.apply(Q.QUICK_ENTRY_DEFAULT_PREF);
  assert.equal(st.state, "taken");
  assert.equal(host.held.size, 0);
  assert.equal(Q.QUICK_ENTRY_DEFAULT_PREF.enabled, true);
  assert.equal(Q.quickEntryStateLine(st), Q.SHORTCUT_TAKEN_MESSAGE);
});

test("a Settings write that takes is saved", () => {
  const dir = tmp();
  const s = new Q.QuickEntryShortcut(fakeHost(), () => {});
  const out = Q.settleQuickEntrySet(Q.QUICK_ENTRY_DEFAULT_PREF, { accelerator: "Ctrl+Alt+K" }, s, (p) => Q.writeQuickEntryPref(dir, p));
  assert.equal(out.ok, true);
  assert.equal(Q.readQuickEntryPref(dir).accelerator, "Control+Alt+K");
});

test("a register that throws (a combo Electron does not parse) is invalid, not a crash", () => {
  const host = fakeHost();
  host.register = () => { throw new Error("conversion failure"); };
  const s = new Q.QuickEntryShortcut(host, () => {});
  const st = s.apply(Q.QUICK_ENTRY_DEFAULT_PREF);
  assert.equal(st.state, "invalid");
  assert.match(Q.quickEntryStateLine(st), /conversion failure/);
});

test("changing the combo lets go of the old one first; off, pause and dispose release it; never unregisterAll", () => {
  const host = fakeHost();
  const s = new Q.QuickEntryShortcut(host, () => {});
  s.apply(Q.QUICK_ENTRY_DEFAULT_PREF);
  s.apply({ enabled: true, accelerator: "Alt+Space" });
  assert.deepEqual([...host.held.keys()], ["Alt+Space"]);
  s.pause();
  assert.deepEqual([...host.held.keys()], []);
  s.apply({ enabled: true, accelerator: "Alt+Space" });
  assert.deepEqual(s.apply({ enabled: false, accelerator: "Alt+Space" }), { state: "off" });
  assert.deepEqual([...host.held.keys()], []);
  s.apply({ enabled: true, accelerator: "Alt+Space" });
  s.dispose();
  assert.deepEqual([...host.held.keys()], []);
  assert.deepEqual(s.state(), { state: "off" });
  // Something else of ours (the marks overlay's Esc) is never touched.
  host.held.set("Escape", () => {});
  s.apply(Q.QUICK_ENTRY_DEFAULT_PREF);
  s.dispose();
  assert.ok(host.held.has("Escape"));
});

test("smoke runs, the first-run probe, the models test and the env switch register nothing", () => {
  const base = { smoke: false, probe: false, modelsTest: false, envOff: false };
  assert.equal(Q.quickEntrySkipReason(base), null);
  for (const k of ["smoke", "probe", "modelsTest", "envOff"]) {
    const reason = Q.quickEntrySkipReason({ ...base, [k]: true });
    assert.equal(typeof reason, "string", k);
    const host = fakeHost();
    const s = new Q.QuickEntryShortcut(host, () => {}, reason);
    assert.equal(s.apply(Q.QUICK_ENTRY_DEFAULT_PREF).state, "skipped");
    assert.deepEqual(host.calls, [], `${k}: globalShortcut is not called`);
  }
});

/* A laptop as the primary display, an external monitor to its LEFT and higher (negative points). */
const LAPTOP = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 33, width: 1512, height: 949 } };
const LEFT = { bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, workArea: { x: -1920, y: -200, width: 1920, height: 1040 } };

test("the box opens on the display under the cursor, centred, a fifth of the way down", () => {
  const onLaptop = Q.quickEntryBounds({ x: 100, y: 500 }, [LAPTOP, LEFT]);
  assert.deepEqual(onLaptop, { x: 436, y: 33 + 190, width: 640, height: 64 });
  const onLeft = Q.quickEntryBounds({ x: -50, y: 0 }, [LAPTOP, LEFT]);
  assert.deepEqual(onLeft, { x: -1920 + 640, y: -200 + 208, width: 640, height: 64 });
});

test("a cursor between screens picks the nearest one; a tiny screen keeps the box inside it", () => {
  assert.equal(Q.displayUnderCursor({ x: 1600, y: 10 }, [LEFT, LAPTOP]), LAPTOP);
  assert.equal(Q.displayUnderCursor({ x: 0, y: 0 }, []), null);
  const tiny = { bounds: { x: 0, y: 0, width: 400, height: 300 }, workArea: { x: 0, y: 0, width: 400, height: 300 } };
  const b = Q.quickEntryBounds({ x: 10, y: 10 }, [tiny]);
  assert.ok(b.x >= 0 && b.x + b.width <= 400 && b.y >= 0 && b.y + b.height <= 300, JSON.stringify(b));
  for (const v of Object.values(b)) assert.ok(Number.isInteger(v));
});

test("window level: floating on macOS, screen-saver elsewhere", () => {
  assert.equal(Q.quickEntryWindowLevel("darwin"), "floating");
  assert.equal(Q.quickEntryWindowLevel("win32"), "screen-saver");
  assert.equal(Q.quickEntryWindowLevel("linux"), "screen-saver");
});

test("the text Enter sends: trimmed, empty is nothing, capped", () => {
  assert.equal(Q.quickEntryText("  hi  "), "hi");
  assert.equal(Q.quickEntryText("   "), null);
  assert.equal(Q.quickEntryText(7), null);
  assert.equal(Q.quickEntryText("x".repeat(30_000)).length, 20_000);
});
