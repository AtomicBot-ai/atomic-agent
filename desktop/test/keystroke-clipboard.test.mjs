// Unit tests for main/keystroke-clipboard.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-985 / ATO-1064: a copy or a paste in the app in front through the
// clipboard, and the user's own clipboard put back afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../out/main/keystroke-clipboard.js");

/* ATO-2804: the C# that Add-Type compiles, the -MemberDefinition
   single-quoted string as PowerShell reads it ('' is one '). C# takes
   '...' as one char, so DllImport('user32.dll') does not compile (CS1012). */
function memberDefinition(script) {
  const m = /-MemberDefinition '((?:[^']|'')*)'/.exec(script);
  assert.ok(m, "an Add-Type -MemberDefinition '...'");
  return m[1].replace(/''/g, "'");
}

/** A fake clipboard; `onPress` plays the app in front. */
function fakeHost(initial = "mine") {
  const log = [];
  const box = { text: initial };
  const host = {
    save: () => { log.push("save"); return { text: box.text }; },
    restore: (s) => { log.push("restore"); box.text = s.text; },
    readText: () => box.text,
    writeText: (t) => { log.push("write"); box.text = t; },
    clear: () => { log.push("clear"); box.text = ""; },
  };
  return { host, box, log };
}
const noSleep = () => Promise.resolve();

test("the key press per platform: osascript, SendKeys, xdotool or wtype", () => {
  const mac = K.keystrokeCommands("copy", { platform: "darwin", env: {} });
  assert.equal(mac.length, 1);
  assert.equal(mac[0].file, "/usr/bin/osascript");
  assert.deepEqual(mac[0].args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.match(mac[0].args[3], /keystroke\('c', \{ using: 'command down' \}\)/);
  assert.deepEqual(K.keystrokeCommands("paste", { platform: "darwin", env: {} })[0].args, ["-e", 'tell application "System Events" to keystroke "v" using command down']);

  const win = K.keystrokeCommands("paste", { platform: "win32", env: {} });
  assert.equal(win[0].file, "powershell.exe");
  assert.match(win[0].args.at(-1), /SendWait\('\^v'\)/);
  assert.ok(win[0].args.includes("-NoProfile"));

  assert.deepEqual(K.keystrokeCommands("copy", { platform: "linux", env: { DISPLAY: ":0" } }).map((c) => c.file), ["xdotool"]);
  assert.deepEqual(K.keystrokeCommands("copy", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" } }).map((c) => c.file), ["wtype", "xdotool"]);
  assert.deepEqual(K.keystrokeCommands("copy", { platform: "linux", env: {} }), [], "no display: nothing to press");
  assert.deepEqual(K.keystrokeCommands("copy", { platform: "freebsd", env: {} }), []);
});

test("Windows: a copy is never pressed into a console or terminal, a paste still is", () => {
  const copy = K.keystrokeCommands("copy", { platform: "win32", env: {} })[0].args.at(-1);
  assert.match(copy, /GetForegroundWindow/);
  assert.match(copy, /GetWindowThreadProcessId/);
  assert.match(copy, new RegExp(`exit ${K.WIN_CONSOLE_SKIP_EXIT}`));
  for (const name of K.WINDOWS_CONSOLE_PROCESSES) assert.ok(copy.includes(`'${name}'`), `${name} in the guard`);
  assert.ok(copy.indexOf("GetForegroundWindow") < copy.indexOf("SendWait('^c')"), "the check runs before the key press");
  const cs = memberDefinition(copy);
  assert.ok(cs.includes('[DllImport("user32.dll")]'), cs);
  assert.doesNotMatch(cs, /'[^']{2,}'/, "no multi-character char literal in the C#: it must compile");

  const paste = K.keystrokeCommands("paste", { platform: "win32", env: {} })[0].args.at(-1);
  assert.doesNotMatch(paste, /GetForegroundWindow/, "a paste interrupts nothing, so no guard");

  for (const n of ["cmd", "cmd.exe", "PowerShell", "pwsh", "WindowsTerminal", "conhost", "OpenConsole", "mintty", "alacritty", "wezterm-gui", "wt", "ConEmu64", "ConEmu", "Hyper", "Tabby", "Warp", "warp.exe"]) {
    assert.equal(K.isWindowsConsoleProcess(n), true, n);
  }
  for (const n of ["Code", "chrome", "notepad", "WINWORD", "", null, undefined]) {
    assert.equal(K.isWindowsConsoleProcess(n), false, String(n));
  }
});

test("a copy waits for the hotkey's modifiers to be up, a paste does not (ATO-985 review)", () => {
  assert.equal(K.MODIFIER_POLL_MS, 30);
  assert.equal(K.MODIFIER_WAIT_CAP_MS, 600);

  const mac = K.keystrokeCommands("copy", { platform: "darwin", env: {} })[0].args.at(-1);
  assert.match(mac, /\$\.NSEvent\.modifierFlags/);
  assert.ok(mac.includes(`& ${K.MAC_MODIFIER_MASK})`), "checks the modifier mask");
  assert.equal(K.MAC_MODIFIER_MASK, 0x1e0000, "Shift, Control, Option and Command");
  assert.ok(mac.includes(`waited < ${K.MODIFIER_WAIT_CAP_MS}`), "capped");
  assert.ok(mac.includes(`delay(${K.MODIFIER_POLL_MS / 1000})`), "polls");
  assert.ok(mac.includes(`$.exit(${K.MODIFIERS_HELD_EXIT})`), "skips when still held");
  assert.ok(mac.indexOf("modifierFlags") < mac.indexOf("keystroke("), "the wait runs before the key press");
  assert.ok(mac.indexOf(`$.exit(${K.MODIFIERS_HELD_EXIT})`) < mac.indexOf("keystroke("), "a skip presses nothing");
  assert.ok(!mac.includes('"'), "single quotes only");

  const win = K.keystrokeCommands("copy", { platform: "win32", env: {} })[0].args.at(-1);
  assert.match(win, /GetAsyncKeyState/);
  assert.deepEqual([...K.WIN_MODIFIER_VKEYS], [0x10, 0x11, 0x12, 0x5b, 0x5c], "Shift, Ctrl, Alt, both Win keys");
  assert.ok(win.includes(`foreach ($k in ${K.WIN_MODIFIER_VKEYS.join(",")})`));
  assert.ok(win.includes(`-lt ${K.MODIFIER_WAIT_CAP_MS}`), "capped");
  assert.ok(win.includes(`Start-Sleep -Milliseconds ${K.MODIFIER_POLL_MS}`), "polls");
  assert.ok(win.indexOf(`exit ${K.MODIFIERS_HELD_EXIT}`) < win.indexOf("SendWait('^c')"), "a skip presses nothing");
  assert.ok(win.indexOf(`exit ${K.WIN_CONSOLE_SKIP_EXIT}`) < win.indexOf("GetAsyncKeyState($k)"), "the console check still comes first");

  for (const platform of ["darwin", "win32"]) {
    const paste = K.keystrokeCommands("paste", { platform, env: {} })[0].args.at(-1);
    assert.doesNotMatch(paste, /modifierFlags|GetAsyncKeyState/, `${platform}: the paste is unchanged`);
  }
});

test("modifiers still held at the cap: no copy is pressed, no selection, the clipboard comes back", async () => {
  // The fake plays the script: Shift stays down past MODIFIER_WAIT_CAP_MS, so it
  // exits with MODIFIERS_HELD_EXIT before any key press and the host sees a failed run.
  const { host, box } = fakeHost("mine");
  let copied = false;
  const shiftHeldMs = K.MODIFIER_WAIT_CAP_MS + 200;
  const press = async (kind) => {
    assert.equal(kind, "copy");
    let waited = 0;
    while (waited < shiftHeldMs && waited < K.MODIFIER_WAIT_CAP_MS) waited += K.MODIFIER_POLL_MS;
    if (waited < shiftHeldMs) return false;
    copied = true; box.text = "selected"; return true;
  };
  assert.equal(await K.grabSelectionByCopy(host, { press, sleep: noSleep }), null);
  assert.equal(copied, false, "no wrong chord was sent");
  assert.equal(box.text, "mine");

  // Released in time: the same fake copies once the key is up.
  const two = fakeHost("mine");
  const quick = async () => { two.box.text = "selected"; return true; };
  assert.equal(await K.grabSelectionByCopy(two.host, { press: quick, sleep: noSleep }), "selected");
  assert.equal(two.box.text, "mine");
});

test("a copy the system refused to press (console in front) gives no selection and keeps the clipboard", async () => {
  const { host, box } = fakeHost("mine");
  const text = await K.grabSelectionByCopy(host, { press: async () => false, sleep: noSleep });
  assert.equal(text, null);
  assert.equal(box.text, "mine");
});

test("Linux reads the PRIMARY selection straight; other systems do not", () => {
  assert.deepEqual(K.primarySelectionCommands({ platform: "linux", env: { DISPLAY: ":0" } }).map((c) => c.file), ["xclip", "xsel"]);
  assert.deepEqual(K.primarySelectionCommands({ platform: "linux", env: { WAYLAND_DISPLAY: "w" } }).map((c) => c.file), ["wl-paste"]);
  assert.deepEqual(K.primarySelectionCommands({ platform: "darwin", env: {} }), []);
  assert.deepEqual(K.primarySelectionCommands({ platform: "win32", env: {} }), []);
});

test("cleanSelection trims, caps and drops nothing-at-all", () => {
  assert.equal(K.cleanSelection("  hello\r\nworld  "), "hello\nworld");
  assert.equal(K.cleanSelection("   "), null);
  assert.equal(K.cleanSelection(42), null);
  assert.equal(K.cleanSelection("x".repeat(K.SELECTION_MAX_CHARS + 50)).length, K.SELECTION_MAX_CHARS);
});

test("a grab: save, clear, copy, read, and the old clipboard comes back", async () => {
  const { host, box, log } = fakeHost("mine");
  const press = async (kind) => { assert.equal(kind, "copy"); box.text = "  the selected words "; return true; };
  const got = await K.grabSelectionByCopy(host, { press, sleep: noSleep });
  assert.equal(got, "the selected words");
  assert.deepEqual(log, ["save", "clear", "restore"]);
  assert.equal(box.text, "mine");
});

test("nothing selected: the copy never lands, null, and the clipboard is put back", async () => {
  const { host, box } = fakeHost("mine");
  let sleeps = 0;
  const got = await K.grabSelectionByCopy(host, { press: async () => true, sleep: async () => { sleeps++; } }, { settleMs: 0, timeoutMs: 90, pollMs: 30 });
  assert.equal(got, null);
  assert.equal(box.text, "mine");
  assert.equal(sleeps, 3, "polled until the time ran out");
});

test("a copy that cannot be pressed or throws still puts the clipboard back", async () => {
  for (const press of [async () => false, async () => { throw new Error("osascript -1743"); }]) {
    const { host, box } = fakeHost("mine");
    assert.equal(await K.grabSelectionByCopy(host, { press, sleep: noSleep }), null);
    assert.equal(box.text, "mine");
  }
});

test("a paste: the text goes in, ⌘V, and the old clipboard comes back", async () => {
  const { host, box, log } = fakeHost("mine");
  let seen = null;
  const press = async (kind) => { assert.equal(kind, "paste"); seen = box.text; return true; };
  const out = await K.pasteByKeystroke(host, { press, sleep: noSleep }, "dictated words");
  assert.deepEqual(out, { pasted: true, restored: true });
  assert.equal(seen, "dictated words", "the app in front read the dictated text");
  assert.equal(box.text, "mine");
  assert.deepEqual(log, ["save", "write", "restore"]);
});

test("a copy the user made meanwhile is not overwritten", async () => {
  const { host, box } = fakeHost("mine");
  const sleep = async () => { box.text = "copied by the user"; };
  const out = await K.pasteByKeystroke(host, { press: async () => true, sleep }, "dictated");
  assert.deepEqual(out, { pasted: true, restored: false });
  assert.equal(box.text, "copied by the user");
});

test("no key press possible: the text stays on the clipboard for a paste by hand", async () => {
  const { host, box } = fakeHost("mine");
  const out = await K.pasteByKeystroke(host, { press: async () => false, sleep: noSleep }, "dictated");
  assert.deepEqual(out, { pasted: false, reason: "no-keystroke" });
  assert.equal(box.text, "dictated");
  assert.deepEqual(await K.pasteByKeystroke(host, { press: async () => true, sleep: noSleep }, ""), { pasted: false, reason: "no-text" });
});
