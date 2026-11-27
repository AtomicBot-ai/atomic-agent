// Unit tests for main/terminal-pick.ts (ATO-1430), against the built output.
// Run: npm run build && npm run test:unit
// Which terminal "Open in Terminal" starts on Windows and Linux, with a fake
// PATH lookup: the order, the argv (never the command, never the folder),
// the hint, and the plain PATH search behind the real lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/terminal-pick.js");

/** A `which` that finds only `names`, at /fake/<name>. */
const whichOf = (...names) => (n) => (names.includes(n) ? "/fake/" + n : null);

test("Windows: Windows Terminal first, opened in its own cwd (-d .), PowerShell next in its own console", () => {
  const both = P.terminalChoices("win32", whichOf("wt.exe", "powershell.exe"));
  assert.deepEqual(both, [
    { terminal: "windows-terminal", file: "/fake/wt.exe", args: ["-d", "."] },
    { terminal: "powershell", file: "/fake/powershell.exe", args: ["-NoLogo", "-NoExit"], newConsole: true },
  ]);
  assert.deepEqual(P.terminalChoices("win32", whichOf("powershell.exe")).map((c) => c.terminal), ["powershell"]);
  assert.deepEqual(P.terminalChoices("win32", whichOf()), []);
});

test("Linux: x-terminal-emulator, gnome-terminal, konsole, xterm, each running the launcher", () => {
  const all = P.terminalChoices("linux", whichOf("xterm", "konsole", "gnome-terminal", "x-terminal-emulator"), "/t/l/open.command");
  assert.deepEqual(all.map((c) => c.terminal), ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]);
  assert.deepEqual(all.find((c) => c.terminal === "gnome-terminal").args, ["--", "/t/l/open.command"]);
  for (const c of all.filter((c) => c.terminal !== "gnome-terminal")) assert.deepEqual(c.args, ["-e", "/t/l/open.command"], c.terminal);
  assert.deepEqual(P.terminalChoices("linux", whichOf("konsole", "xterm"), "/l").map((c) => c.terminal), ["konsole", "xterm"]);
  assert.deepEqual(P.terminalChoices("linux", whichOf(), "/l"), [], "none installed: an empty list");
  assert.deepEqual(P.terminalChoices("linux", whichOf("xterm")), [], "no launcher: nothing to run");
});

test("macOS and other systems have no choice here (terminal-open.ts owns macOS)", () => {
  for (const platform of ["darwin", "freebsd"]) assert.deepEqual(P.terminalChoices(platform, whichOf("xterm", "wt.exe"), "/l"), [], platform);
});

test("no argv ever holds the folder: it is the spawn's cwd", () => {
  for (const [platform, names] of [["win32", ["wt.exe", "powershell.exe"]], ["linux", ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]]]) {
    for (const c of P.terminalChoices(platform, whichOf(...names), "/l")) {
      assert.ok(c.args.every((a) => a === "/l" || a.startsWith("-") || a === "."), platform + " " + c.terminal + ": " + c.args.join(" "));
    }
  }
});

test("pasteHint: Ctrl+V on Windows, Ctrl+Shift+V in a Linux terminal, typed-in for zsh", () => {
  assert.match(P.pasteHint("win32"), /clipboard.*Ctrl\+V, then press Enter/);
  assert.doesNotMatch(P.pasteHint("win32", "/bin/zsh"), /typed/, "Windows never types it in");
  assert.match(P.pasteHint("linux", "/bin/bash"), /Ctrl\+Shift\+V, then press Enter/);
  assert.match(P.pasteHint("linux", null), /Ctrl\+Shift\+V/);
  assert.match(P.pasteHint("linux", "/usr/bin/zsh"), /typed into the terminal, not run/);
  assert.equal(P.shellIsZsh("/usr/bin/zsh"), true);
  assert.equal(P.shellIsZsh("zsh"), true);
  assert.equal(P.shellIsZsh("/bin/zsh5"), false);
  assert.equal(P.shellIsZsh(undefined), false);
});

test("noTerminalMessage names what to install and says the command is on the clipboard", () => {
  assert.match(P.noTerminalMessage("win32"), /Windows Terminal.*PowerShell.*clipboard/);
  assert.match(P.noTerminalMessage("linux"), /x-terminal-emulator, gnome-terminal, konsole or xterm.*clipboard/);
});

test("makeWhich (POSIX): PATH order, absolute dirs only, no names with a slash", () => {
  const files = new Set(["/usr/local/bin/xterm", "/usr/bin/xterm", "/usr/bin/konsole"]);
  const which = P.makeWhich({ platform: "linux", path: "relative/bin::/usr/local/bin:/usr/bin", isFile: (p) => files.has(p) });
  assert.equal(which("xterm"), "/usr/local/bin/xterm");
  assert.equal(which("konsole"), "/usr/bin/konsole");
  assert.equal(which("gnome-terminal"), null);
  assert.equal(which("../bin/xterm"), null);
  assert.equal(which(""), null);
  assert.equal(P.makeWhich({ platform: "linux", path: undefined, isFile: () => true })("xterm"), null, "no PATH: nothing");
});

test("makeWhich (Windows): ; separated, quoted dirs, PATHEXT, a name with its own extension", () => {
  const files = new Set(["C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
  const which = P.makeWhich({
    platform: "win32",
    path: "\"C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\";C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    pathExt: ".COM;.EXE;.BAT",
    isFile: (p) => files.has(p),
  });
  assert.equal(which("wt.exe"), "C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe");
  assert.equal(which("powershell"), "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(which("cmd.exe"), null);
  assert.equal(which("C:\\x\\wt.exe"), null);
});
