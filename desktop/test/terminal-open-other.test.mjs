// Unit tests for main/terminal-open-other.ts (ATO-1430), against the built output.
// Run: npm run build && npm run test:unit
// "Open in Terminal" on Windows and Linux: the command goes on the clipboard
// (and, on Linux, into the launch folder's 0600 file), never into an argv;
// the terminal opens in the chat's folder; no terminal is a clear message.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const O = require("../out/main/terminal-open-other.js");
const T = require("../out/main/terminal-open.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato1430-")); dirs.push(d); return d; };
const posix = process.platform !== "win32";

function deps(over = {}) {
  const spawned = [];
  const clip = [];
  const home = fresh();
  const proj = fresh();
  return {
    spawned, clip, home, proj,
    d: {
      platform: "win32",
      home,
      root: join(fresh(), "atomic-agent-terminal"),
      which: (n) => (["wt.exe", "powershell.exe", "x-terminal-emulator", "xterm"].includes(n) ? "/fake/" + n : null),
      spawn: async (choice, cwd) => {
        // What the launcher would read, while the folder still exists.
        const files = choice.args.filter((a) => a.endsWith("open.command")).map((l) => readdirSync(join(l, "..")).sort());
        spawned.push({ ...choice, cwd, files });
        return true;
      },
      writeClipboard: (t) => clip.push(t),
      shell: "/bin/bash",
      ...over,
    },
  };
}

const CMD = "rm -rf build && echo \"$HOME\"; ls | wc -l";

test("Windows: clipboard, Windows Terminal in the chat's folder, the hint, nothing in the argv", async () => {
  const { d, spawned, clip, proj } = deps();
  const res = await O.openOtherTerminalWithCommand({ command: CMD + "\r\n", cwd: proj }, d);
  assert.deepEqual(res, { ok: true, cwd: proj, usedHome: false, terminal: "windows-terminal", hint: res.hint });
  assert.match(res.hint, /Ctrl\+V, then press Enter/);
  assert.deepEqual(clip, [CMD], "the cleaned command on the clipboard");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].file, "/fake/wt.exe");
  assert.deepEqual(spawned[0].args, ["-d", "."]);
  assert.equal(spawned[0].cwd, proj);
  assert.ok(!existsSync(d.root), "Windows writes no launch folder");
});

test("Windows: no Windows Terminal → PowerShell; one that fails to start → the next", async () => {
  const only = deps({ which: (n) => (n === "powershell.exe" ? "C:\\ps\\powershell.exe" : null) });
  const a = await O.openOtherTerminalWithCommand({ command: "dir", cwd: only.proj }, only.d);
  assert.equal(a.ok, true);
  assert.equal(a.terminal, "powershell");
  assert.equal(only.spawned[0].newConsole, true);

  const tried = [];
  const flaky = deps({ spawn: async (c) => { tried.push(c.terminal); return c.terminal !== "windows-terminal"; } });
  const b = await O.openOtherTerminalWithCommand({ command: "dir", cwd: flaky.proj }, flaky.d);
  assert.equal(b.terminal, "powershell");
  assert.deepEqual(tried, ["windows-terminal", "powershell"]);
});

test("no terminal found: a clear message, not silence, and the command still on the clipboard", async () => {
  for (const platform of ["win32", "linux"]) {
    const { d, clip, spawned } = deps({ platform, which: () => null });
    const res = await O.openOtherTerminalWithCommand({ command: "ls", cwd: null }, d);
    assert.equal(res.ok, false, platform);
    assert.equal(res.error, "no-terminal", platform);
    assert.match(res.message, /No terminal was found/, platform);
    assert.deepEqual(clip, ["ls"], platform);
    assert.equal(spawned.length, 0);
    if (platform === "linux") assert.deepEqual(readdirSync(d.root), [], "the launch folder is removed");
  }
});

test("every terminal failing to start: open-failed, with the clipboard named", async () => {
  const { d } = deps({ spawn: async () => false });
  const res = await O.openOtherTerminalWithCommand({ command: "ls", cwd: null }, d);
  assert.equal(res.error, "open-failed");
  assert.match(res.message, /clipboard/);
});

test("Linux: clipboard + a 0600 command file; the terminal runs the constant launcher", { skip: !posix }, async () => {
  const { d, spawned, clip, proj } = deps({ platform: "linux" });
  const res = await O.openOtherTerminalWithCommand({ command: CMD, cwd: proj }, d);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, "x-terminal-emulator");
  assert.match(res.hint, /Ctrl\+Shift\+V/);
  assert.deepEqual(clip, [CMD]);
  const s = spawned[0];
  assert.equal(s.file, "/fake/x-terminal-emulator");
  assert.equal(s.args[0], "-e");
  assert.equal(s.args.length, 2);
  assert.ok(!s.args.some((a) => a.includes("rm -rf")), "the command is not in the argv");
  assert.deepEqual(s.files, [["cmd", "cwd", "open.command", "zdot"]], "one launcher, and what its folder holds");
  const dir = join(s.args[1], "..");
  assert.equal(readFileSync(join(dir, "cmd"), "utf8"), CMD);
  assert.equal(readFileSync(join(dir, "cwd"), "utf8"), proj);
  assert.equal(statSync(join(dir, "cmd")).mode & 0o777, 0o600);
  assert.equal(readFileSync(s.args[1], "utf8"), O.LINUX_LAUNCHER_SCRIPT, "the Linux launcher, not the macOS one");
  assert.equal(readFileSync(join(dir, "zdot", ".zshenv"), "utf8"), T.ZSHENV_SCRIPT, "zsh gets the same print -rz hook as macOS");
});

test("Linux zsh: the hint says it is typed in, not run", { skip: !posix }, async () => {
  const { d } = deps({ platform: "linux", shell: "/usr/bin/zsh" });
  const res = await O.openOtherTerminalWithCommand({ command: "ls", cwd: null }, d);
  assert.match(res.hint, /typed into the terminal, not run/);
});

test("the Linux launcher holds no command, pastes with Ctrl+Shift+V, and has no pbcopy", () => {
  const L = O.LINUX_LAUNCHER_SCRIPT;
  assert.match(L, /^#!\/bin\/sh\n/);
  assert.match(L, /cat -- "\$here\/cwd"/);
  assert.match(L, /ZDOTDIR=\$here\/zdot/);
  assert.match(L, /Ctrl\+Shift\+V/);
  assert.doesNotMatch(L, /pbcopy|Cmd\+V|eval/);
});

test("the shared checks still apply: bad input is refused before the clipboard is touched", async () => {
  for (const [command, error] of [[42, "invalid-request"], ["  \n", "empty-command"], ["echo \u001b]0;x\u0007", "control-characters"], ["a".repeat(65537), "command-too-long"]]) {
    const { d, clip, spawned } = deps();
    const res = await O.openOtherTerminalWithCommand({ command, cwd: null }, d);
    assert.equal(res.error, error);
    assert.deepEqual(clip, []);
    assert.equal(spawned.length, 0);
  }
  const { d } = deps();
  assert.equal((await O.openOtherTerminalWithCommand(null, d)).error, "invalid-request");
  assert.equal((await O.openOtherTerminalWithCommand({ command: "ls" }, { ...d, platform: "darwin" })).error, "unsupported");
});

test("a folder that is not there opens in the home folder", async () => {
  const { d, spawned, home } = deps();
  const res = await O.openOtherTerminalWithCommand({ command: "ls", cwd: join(home, "nope") }, d);
  assert.equal(res.usedHome, true);
  assert.equal(spawned[0].cwd, home);
});
