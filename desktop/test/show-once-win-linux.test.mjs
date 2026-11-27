// ATO-2499 "Show once" on Windows and Linux: whether this computer can record
// (Wayland and a missing xdotool say why), the Windows PowerShell helper on the
// Mac helper's line protocol, xdotool's answers, the Windows/Linux app lists,
// keys read the Windows way, a SKILL.md that walks the user through the steps,
// and the card. Runs against the compiled out/main (npm run build first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/show-once-platform.js");
const W = require("../out/main/show-once-win.js");
const X = require("../out/main/show-once-linux.js");
const C = require("../out/main/show-once-classify.js");
const L = require("../out/main/show-once-log.js");
const PR = require("../out/main/show-once-prober.js");
const S = require("../out/main/show-once-skill.js");
const R = require("../renderer/show-once.js");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("support: Wayland and a missing xdotool say why; X11 with xdotool, Windows and macOS record", () => {
  const yes = () => true;
  const wayland = P.showOnceSupport("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, yes);
  assert.equal(wayland.ok, false);
  assert.equal(wayland.reason, "wayland");
  assert.match(wayland.message, /X11/);
  assert.equal(P.showOnceSupport("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, yes).reason, "wayland");
  assert.equal(P.showOnceSupport("linux", {}, yes).reason, "no-display");
  const noTool = P.showOnceSupport("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, () => false);
  assert.equal(noTool.reason, "no-xdotool");
  assert.match(noTool.message, /apt install xdotool/);
  assert.deepEqual(P.showOnceSupport("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, yes), { ok: true });
  assert.deepEqual(P.showOnceSupport("win32", {}, () => assert.fail("xdotool is Linux only")), { ok: true });
  assert.deepEqual(P.showOnceSupport("darwin", {}, () => assert.fail("xdotool is Linux only")), { ok: true });
  assert.equal(P.showOnceSupport("freebsd", {}, yes).reason, "platform");
  assert.deepEqual(["darwin", "win32", "linux"].map(P.showOnceOsName), ["macOS", "Windows", "Linux"]);
});

test("gate: Accessibility is asked on macOS only; an unsupported session and a remote agent never start", () => {
  const asked = [];
  const ax = (ok) => (prompt) => { asked.push(prompt); return ok; };
  const mac = P.showOnceGate({ platform: "darwin", remote: false, support: { ok: true }, axTrusted: ax(false) });
  assert.equal(mac.ok, false);
  assert.equal(mac.permission, true);
  assert.deepEqual(asked, [false, true], "macOS shows its own prompt");
  asked.length = 0;
  assert.deepEqual(P.showOnceGate({ platform: "win32", remote: false, support: { ok: true }, axTrusted: ax(false) }), { ok: true });
  assert.deepEqual(asked, [], "Windows has nothing to allow");
  const wl = P.showOnceSupport("linux", { XDG_SESSION_TYPE: "wayland" }, () => true);
  assert.equal(P.showOnceGate({ platform: "linux", remote: false, support: wl, axTrusted: ax(true) }).reason, "wayland");
  assert.equal(P.showOnceGate({ platform: "win32", remote: true, support: { ok: true }, axTrusted: ax(true) }).reason, "remote");
});

test("Windows helper: Windows PowerShell 5.1, the script as -EncodedCommand, never a control's value", () => {
  assert.equal(W.showOnceWinShell({ SystemRoot: "C:\\Windows" }), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const args = W.showOnceWinArgs();
  assert.equal(args[args.length - 2], "-EncodedCommand");
  assert.equal(Buffer.from(args[args.length - 1], "base64").toString("utf16le"), W.SHOW_ONCE_WIN_SCRIPT);
  assert.ok(args.join(" ").length < 32000, "fits a Windows command line");
  assert.ok(!/ValuePattern|TextPattern|SendKeys|mouse_event|SendInput/.test(W.SHOW_ONCE_WIN_SCRIPT), "reads names only, posts no input");
  assert.match(W.SHOW_ONCE_WIN_SCRIPT, /IsPassword\) \{ return @\{ role = 'AXSecureTextField'; label = '' \}/);
  assert.match(W.SHOW_ONCE_WIN_SCRIPT, /\{"ready":true\}/);
  // A UWP app's top-level window belongs to ApplicationFrameHost; the app is its child window's process.
  assert.match(W.SHOW_ONCE_WIN_SCRIPT, /-ieq 'ApplicationFrameHost'\) \{\s+\$real = \[AtomicShowOnce\]::ChildPid\(\$h, \$procId\)/);
});

test("the prober on Windows runs PowerShell on the helper's protocol; with no PowerShell nothing is named", async () => {
  const spawned = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = {
    write(line) {
      const id = Number(String(line).split(" ")[1]);
      const out = { id, app: { name: "Notepad", bundleId: "notepad.exe", pid: 7 }, windowTitle: "notes.txt - Notepad", element: { role: "AXButton", label: "Save" } };
      setImmediate(() => child.stdout.emit("data", `${JSON.stringify(out)}\n`));
    },
    end() {},
  };
  child.kill = () => {};
  setImmediate(() => child.stdout.emit("data", '{"ready":true}\n'));
  const pr = await PR.openShowOnceProber({
    nativeDir: "C:\\app\\resources\\native", platform: "win32", env: { SystemRoot: "C:\\Windows" }, onPush: () => {}, exists: () => true,
    spawnHelper: (file, args) => { spawned.push([file, args[0]]); return child; },
  });
  assert.deepEqual(spawned, [["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoProfile"]]);
  assert.equal(pr.via, "helper");
  const p = await pr.click(10, 20);
  assert.equal(p.app.bundleId, "notepad.exe");
  assert.equal(p.windowTitle, "notes.txt - Notepad");
  pr.stop();
  const none = await PR.openShowOnceProber({ nativeDir: "/x", platform: "win32", env: {}, onPush: () => {}, exists: () => false });
  assert.equal(none.via, "none");
  assert.equal((await none.key(0)).app, null);
});

test("xdotool: geometry, title and pid; the app named by its executable", () => {
  const out = "WINDOW=6291462\nX=120\nY=80\nWIDTH=900\nHEIGHT=600\nSCREEN=0\nReport.odt - LibreOffice Writer\n4242\n";
  const w = X.parseXdotool(out);
  assert.deepEqual(w, { title: "Report.odt - LibreOffice Writer", pid: 4242, rect: { x: 120, y: 80, width: 900, height: 600 } });
  assert.deepEqual(X.parseXdotool("WINDOW=1\nX=0\nY=0\nWIDTH=10\nHEIGHT=10\nSCREEN=0\nNo pid here\n"), { title: "No pid here", pid: null, rect: { x: 0, y: 0, width: 10, height: 10 } });
  const proc = { readlink: (p) => { assert.equal(p, "/proc/4242/exe"); return "/usr/lib/libreoffice/program/soffice.bin"; }, readFile: () => assert.fail("exe was enough") };
  const probe = X.linuxProbe(w, proc);
  assert.deepEqual(probe.app, { name: "soffice.bin", bundleId: "soffice.bin", pid: 4242 });
  assert.equal(probe.windowTitle, "Report.odt - LibreOffice Writer");
  assert.equal(probe.element, null, "no control names on Linux");
  const commOnly = { readlink: () => { throw new Error("EACCES"); }, readFile: () => "Gedit\n" };
  assert.equal(X.linuxExeName(5, commOnly), "gedit");
  assert.deepEqual(X.SHOW_ONCE_XDOTOOL_ARGS, ["getactivewindow", "getwindowgeometry", "--shell", "getwindowname", "getwindowpid"]);
});

test("Windows and Linux apps: browsers, protected apps and Atomic Agent itself by executable name", () => {
  const app = (bundleId, name = bundleId, pid = 9) => ({ name, bundleId, pid });
  assert.equal(C.showOnceAppClass(app("notepad.exe", "Notepad"), 1), "open");
  assert.equal(C.showOnceAppClass(app("chrome.exe", "Google Chrome"), 1), "browser");
  assert.equal(C.showOnceAppClass(app("firefox"), 1), "browser");
  assert.equal(C.showOnceAppClass(app("keepassxc"), 1), "protected");
  assert.equal(C.showOnceAppClass(app("systemsettings.exe", "Settings"), 1), "protected");
  // A UWP frame whose real app was not reached is never an open app (Settings, Windows Security).
  assert.equal(C.showOnceAppClass(app("applicationframehost.exe", "Application Frame Host"), 1), "unknown");
  assert.equal(C.showOnceAppClass(app("consent.exe", "Consent UI"), 1), "protected");
  // Windows Security, once show-once-win.ts resolves it past ApplicationFrameHost, in either casing.
  assert.equal(C.showOnceAppClass(app("sechealthui.exe", "Windows Security"), 1), "protected");
  assert.equal(C.showOnceAppClass(app("SecHealthUI.exe", "Windows Security"), 1), "protected");
  assert.equal(C.showOnceAppClass(app("gnome-control-center"), 1), "protected");
  assert.equal(C.showOnceAppClass(app("atomic agent.exe", "Atomic Agent"), 1), "own");
  assert.equal(C.showOnceAppClass(app("code.exe", "Visual Studio Code", 1), 1), "own", "the app's own pid");
});

test("keys off the Mac: Ctrl chords are kept, the Windows key, Alt+Tab and Ctrl+Alt+Delete are not", () => {
  const k = (keycode, mods = {}) => ({ keycode, meta: false, ctrl: false, alt: false, shift: false, ...mods });
  assert.deepEqual(C.classifyKey(k(31, { ctrl: true }), "win32"), { kind: "keys", keys: "ctrl+s" });
  assert.deepEqual(C.classifyKey(k(19, { meta: true }), "win32"), { kind: "ignore" }, "Win+R");
  assert.deepEqual(C.classifyKey(k(15, { alt: true }), "linux"), { kind: "ignore" }, "Alt+Tab");
  assert.deepEqual(C.classifyKey(k(3667, { ctrl: true, alt: true }), "win32"), { kind: "ignore" });
  assert.deepEqual(C.classifyKey(k(1, { ctrl: true }), "win32"), { kind: "ignore" }, "Ctrl+Esc");
  assert.deepEqual(C.classifyKey(k(31, { meta: true })), { kind: "keys", keys: "cmd+s" }, "the Mac is unchanged");
  // AltGr reaches the Windows hook as Ctrl+Alt: `@` (AltGr+Q, German) and `ż` (AltGr+Z, Polish) are typing.
  assert.equal(C.classifyKey(k(16, { ctrl: true, alt: true }), "win32").kind, "text");
  assert.equal(C.classifyKey(k(44, { ctrl: true, alt: true, shift: true }), "win32").kind, "text");
  assert.deepEqual(C.classifyKey(k(16, { ctrl: true, alt: true })), { kind: "keys", keys: "ctrl+alt+q" }, "on the Mac Ctrl+Option is a chord");
  const log = new L.ShowOnceLog(1, "win32");
  const notepad = { name: "Notepad", bundleId: "notepad.exe", pid: 9 };
  log.add({ kind: "key", at: 0, ...k(31, { ctrl: true }), app: notepad, focused: null, windowTitle: null });
  log.add({ kind: "key", at: 10, ...k(32, { meta: true }), app: notepad, focused: null, windowTitle: null });
  assert.deepEqual(log.steps.filter((s) => s.kind === "keys").map((s) => s.keys), ["ctrl+s"]);
  const typed = new L.ShowOnceLog(1, "win32");
  for (const [i, e] of [k(30), k(16, { ctrl: true, alt: true }), k(48)].entries()) {
    typed.add({ kind: "key", at: i, ...e, app: notepad, focused: null, windowTitle: null });
  }
  assert.deepEqual(typed.steps.filter((s) => s.kind !== "app").map((s) => s.kind), ["text"], "a@b is one text step, no ctrl+alt+q");
});

test("a Windows or Linux SKILL.md walks the user through each step; the Mac one is unchanged", () => {
  const notepad = { name: "Notepad", bundleId: "notepad.exe", pid: 9 };
  const log = new L.ShowOnceLog(1, "win32");
  log.add({ kind: "click", at: 0, x: 50, y: 60, button: "left", clicks: 1, app: notepad, window: { x: 0, y: 0, width: 800, height: 600 },
    element: { role: "AXButton", label: "Save" }, windowTitle: "notes.txt - Notepad" });
  log.add({ kind: "key", at: 50, keycode: 31, meta: false, ctrl: true, alt: false, shift: false, app: notepad, focused: null, windowTitle: null });
  const at = new Date(2026, 10, 28, 9, 30);
  const win = S.compileShowOnceSkill(log.steps, at, null, "Windows");
  assert.ok(win.content.includes("This was recorded on Windows."));
  assert.ok(win.content.includes("walk the user through it"));
  assert.ok(!/os\.screen\.(press|click|key|type|elements)/.test(win.content), win.content);
  assert.ok(win.content.includes('Click the button "Save" in Notepad.'));
  assert.ok(win.content.includes("Press `ctrl+s` in Notepad."));
  const mac = S.compileShowOnceSkill(log.steps, at);
  assert.ok(mac.content.includes("This runs on macOS with the os.screen tools."));
  assert.ok(mac.content.includes("press it with os.screen.press"));
  assert.equal(S.showOncePlainStep('Click the button "Save" in X. Find it with os.screen.elements and press it with os.screen.press. (At 5, 5.)'), 'Click the button "Save" in X. (At 5, 5.)');
});

test("the card off the Mac: why Record cannot run instead of the button, no picture switch, the tray", () => {
  const base = { available: true, recording: false, saving: false, steps: 0, app: null, startedAt: null, last: null, draftsDir: "/d",
    options: { tidy: true, snapshots: true }, screenAllowed: false, os: "Linux", unsupported: null };
  const wl = R.showOnceCardHTML({ ...base, unsupported: P.SHOW_ONCE_WAYLAND }, esc);
  assert.ok(wl.includes("Wayland does not let one app watch clicks and keys"));
  assert.ok(!wl.includes("skills:showOnce:start"), "no Record button on Wayland");
  const idle = R.showOnceCardHTML(base, esc);
  assert.ok(idle.includes("skills:showOnce:start"));
  assert.ok(idle.includes("an app on this computer"));
  assert.ok(!idle.includes("opt:snapshots") && !idle.includes("skills:showOnce:screen"), "pictures are macOS only");
  const rec = R.showOnceCardHTML({ ...base, recording: true, steps: 2 }, esc);
  assert.ok(rec.includes("system tray") && !rec.includes("menu bar"));
  assert.ok(R.showOnceCardHTML({ ...base, os: "macOS" }, esc).includes("opt:snapshots"));
});

test("packaging: the Linux uiohook-napi prebuilds ship now", () => {
  const cfg = require("../electron-builder.cjs");
  assert.ok(!cfg.files.some((f) => /uiohook-napi\/prebuilds\/linux/.test(f)));
});
