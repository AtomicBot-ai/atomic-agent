// ATO-2738: "Replace in …" on Windows and Linux (main/replace-front-app.ts,
// built output): the window in front, bringing it back, a missing tool, and
// the wiring of the host (read from the sources).
// Run: npm run build && npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../out/main/replace-front-app.js");
const src = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* The C# that Add-Type compiles: the -MemberDefinition single-quoted
   string as PowerShell reads it ('' is one '). C# takes '...' as one char,
   so DllImport('user32.dll') does not compile (CS1012). */
function memberDefinition(script) {
  const m = /-MemberDefinition '((?:[^']|'')*)'/.exec(script);
  assert.ok(m, "an Add-Type -MemberDefinition '...'");
  return m[1].replace(/''/g, "'");
}
function assertCompilableUser32(script) {
  const cs = memberDefinition(script);
  assert.ok(cs.includes('[DllImport("user32.dll")]'), cs);
  assert.doesNotMatch(cs, /'[^']{2,}'/, "no multi-character char literal in the C#");
}

test("Windows: the read is PowerShell and user32, its answer checked, never this app", () => {
  const cmd = F.winFrontCommand();
  assert.equal(cmd.file, "powershell.exe");
  const script = cmd.args.at(-1);
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assertCompilableUser32(script);
  assert.deepEqual(F.parseWinFront('{"hwnd":"132456","pid":4321,"name":"Notepad"}', 1), { name: "Notepad", pid: 4321, hwnd: "132456" });
  assert.equal(F.parseWinFront('{"hwnd":"132456","pid":4321,"name":"  "}', 1).name, "the app");
  assert.equal(F.parseWinFront('{"hwnd":"132456","pid":77,"name":"Atomic Agent"}', 77), null, "our own window");
  for (const bad of ["", "nope", '{"hwnd":"0","pid":5}', '{"hwnd":"12; rm","pid":5}', '{"hwnd":132,"pid":5}', '{"hwnd":"12","pid":"5"}', null]) {
    assert.equal(F.parseWinFront(bad, 1), null, String(bad));
  }
});

test("Windows: bringing it back says ok only when that window is in front; a bad handle runs nothing", () => {
  const cmd = F.winActivateCommand("132456");
  const script = cmd.args.at(-1);
  assert.match(script, /\[System\.IntPtr\]::new\(\[Int64\]132456\)/);
  assertCompilableUser32(script);
  assert.match(script, /IsIconic\(\$h\)\) \{ \[void\]\[AtomicAgent\.Front\]::ShowWindow\(\$h, 9\)/, "a minimized window is restored");
  assert.match(script, /SetForegroundWindow\(\$h\)/);
  assert.match(script, /if \(\[AtomicAgent\.Front\]::GetForegroundWindow\(\) -eq \$h\) \{ 'ok' \} else \{ 'no' \}/);
  assert.equal(F.winActivateCommand("12; Remove-Item"), null);
  assert.equal(F.winActivateCommand(""), null);
});

test("Linux X11: xdotool, ids that are digits, the app's name from its title", () => {
  assert.deepEqual(F.X11_ACTIVE_WINDOW, { file: "xdotool", args: ["getactivewindow"] });
  assert.equal(F.parseXid("62914567\n"), "62914567");
  assert.equal(F.parseXid("oops"), null);
  assert.deepEqual(F.x11ActivateCommand("62914567"), { file: "xdotool", args: ["windowactivate", "--sync", "62914567"] });
  assert.equal(F.x11ActivateCommand("1 && rm"), null);
  assert.deepEqual(F.x11NameCommand("5").args, ["getwindowname", "5"]);
  assert.deepEqual(F.x11PidCommand("5").args, ["getwindowpid", "5"]);
  assert.equal(F.appNameFromTitle("Notes.txt - Mozilla Firefox\n"), "Mozilla Firefox");
  assert.equal(F.appNameFromTitle("README.md - atomic-agent - Visual Studio Code"), "Visual Studio Code");
  assert.equal(F.appNameFromTitle("Untitled 1 \u2014 LibreOffice Writer"), "LibreOffice Writer");
  assert.equal(F.appNameFromTitle("Terminal"), "Terminal");
  assert.equal(F.appNameFromTitle(""), "");
});

test("Linux: Wayland needs wtype, X11 needs xdotool; a missing one is a plain hint on the button", () => {
  const has = (list) => (tool) => list.includes(tool);
  const way = { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } };
  assert.deepEqual(F.linuxFrontPlan(way, has(["wtype"])), { name: "", pid: 0, wayland: true });
  assert.equal(F.linuxFrontPlan(way, has([])).blocked, F.LINUX_WTYPE_HINT);
  const x11 = { platform: "linux", env: { DISPLAY: ":0" } };
  assert.equal(F.linuxFrontPlan(x11, has(["xdotool"])), null, "read the X11 window");
  assert.equal(F.linuxFrontPlan(x11, has([])).blocked, F.LINUX_XDOTOOL_HINT);
  assert.equal(F.linuxFrontPlan({ platform: "linux", env: {} }, has(["xdotool"])).blocked, F.LINUX_XDOTOOL_HINT);
  for (const h of [F.LINUX_XDOTOOL_HINT, F.LINUX_WTYPE_HINT]) {
    assert.match(h, /Ctrl\+V/);
    assert.ok(!h.includes("\u2014"));
  }
});

test("PATH lookup, the paste chord's name, the wait before the paste", () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return p === "/usr/bin/xdotool"; };
  assert.equal(F.onPath("xdotool", { PATH: "/usr/local/bin:/usr/bin/" }, exists), true);
  assert.deepEqual(seen, ["/usr/local/bin/xdotool", "/usr/bin/xdotool"]);
  assert.equal(F.onPath("wtype", { PATH: "/usr/bin" }, exists), false);
  assert.equal(F.onPath("wtype", {}, exists), false);
  assert.equal(F.pasteKeyLabel("darwin"), "⌘V");
  assert.equal(F.pasteKeyLabel("win32"), "Ctrl+V");
  assert.equal(F.pasteKeyLabel("linux"), "Ctrl+V");
  assert.equal(F.replaceFocusMs({ name: "", pid: 0, wayland: true }), 350);
  assert.equal(F.replaceFocusMs({ name: "Notepad", pid: 9, hwnd: "1" }), 150);
});

test("the host: one place reads and brings back the window on every platform; the hotkey and the paste use it", () => {
  const host = src("../main/replace-front-app-host.ts");
  assert.match(host, /if \(process\.platform === "darwin"\) return await readMacFrontApp\(\);/);
  assert.match(host, /run\(winFrontCommand\(\), 5000\)/);
  assert.match(host, /linuxFrontPlan\(env\(\), has\) \?\? \(await readX11\(\)\)/);
  assert.match(host, /if \(target\.wayland\) return true;/);
  assert.match(host, /out\.ran && out\.stdout\.trim\(\) === "ok"/);
  assert.match(src("../main/selected-text-ipc.ts"), /import \{ readFrontApp \} from "\.\/replace-front-app-host\.js";/);
  assert.match(src("../main/quick-entry-window.ts"), /import \{ activateApp \} from "\.\/replace-front-app-host\.js";/);
  assert.match(src("../main/keystroke-clipboard-host.ts"), /export function run\(cmd: KeystrokeCommand, timeoutMs: number\)/);
});
