// Unit tests for main/keystroke-clipboard.ts, against the built output.
// Run: npm run build && npm run test:unit
// ATO-985 / ATO-1064: a copy or a paste in the app in front through the
// clipboard, and the user's own clipboard put back afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const K = require("../out/main/keystroke-clipboard.js");

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
  assert.deepEqual(mac[0].args, ["-e", 'tell application "System Events" to keystroke "c" using command down']);
  assert.match(K.keystrokeCommands("paste", { platform: "darwin", env: {} })[0].args[1], /keystroke "v" using command down/);

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
  assert.ok(!copy.includes('"'), "no double quotes on the PowerShell command line");

  const paste = K.keystrokeCommands("paste", { platform: "win32", env: {} })[0].args.at(-1);
  assert.doesNotMatch(paste, /GetForegroundWindow/, "a paste interrupts nothing, so no guard");

  for (const n of ["cmd", "cmd.exe", "PowerShell", "pwsh", "WindowsTerminal", "conhost", "OpenConsole", "mintty", "alacritty", "wezterm-gui", "wt"]) {
    assert.equal(K.isWindowsConsoleProcess(n), true, n);
  }
  for (const n of ["Code", "chrome", "notepad", "WINWORD", "", null, undefined]) {
    assert.equal(K.isWindowsConsoleProcess(n), false, String(n));
  }
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
