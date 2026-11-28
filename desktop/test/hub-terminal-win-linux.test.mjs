// ATO-2782: the Agents sheet's "Open in Terminal" and "Open on local model"
// on Windows and Linux. Against the built output (npm run build first), like
// terminal-open-other.test.mjs. Windows Terminal is asked for a PowerShell
// tab by name (the launch line is PowerShell syntax, and a cmd.exe default
// profile would fail on it); the argv stays constant; the folder is the
// spawn's cwd; hostile folder names and ids never reach an argv.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/terminal-pick.js");
const O = require("../out/main/terminal-open-other.js");
const H = require("../out/main/hub-launch-command.js");
const R = require("../renderer/agent-hub.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato2782-")); dirs.push(d); return d; };
const posix = process.platform !== "win32";
const whichOf = (...names) => (n) => (names.includes(n) ? "/fake/" + n : null);
const PS_TAB = ["new-tab", "-d", ".", "powershell.exe", "-NoLogo", "-NoExit"];

function deps(over = {}) {
  const spawned = [];
  const clip = [];
  return {
    spawned, clip,
    d: {
      platform: "win32",
      home: fresh(),
      root: join(fresh(), "atomic-agent-terminal"),
      which: whichOf("wt.exe", "powershell.exe", "x-terminal-emulator"),
      spawn: async (choice, cwd) => { spawned.push({ ...choice, cwd }); return true; },
      writeClipboard: (t) => clip.push(t),
      shell: "/bin/bash",
      ...over,
    },
  };
}

test("terminal-pick: Windows Terminal opens a PowerShell tab when asked, its default profile otherwise", () => {
  assert.deepEqual(P.windowsTerminalArgs({ powershell: true }), PS_TAB);
  assert.deepEqual(P.windowsTerminalArgs(), ["-d", "."]);
  assert.deepEqual(P.windowsTerminalArgs({ powershell: false }), ["-d", "."]);
  const ps = P.terminalChoices("win32", whichOf("wt.exe", "powershell.exe"), undefined, { powershell: true });
  assert.deepEqual(ps, [
    { terminal: "windows-terminal", file: "/fake/wt.exe", args: PS_TAB },
    { terminal: "powershell", file: "/fake/powershell.exe", args: ["-NoLogo", "-NoExit"], newConsole: true },
  ]);
  // Linux and macOS ignore the wish.
  assert.deepEqual(P.terminalChoices("linux", whichOf("xterm"), "/l", { powershell: true })[0].args, ["-e", "/l"]);
  assert.deepEqual(P.terminalChoices("darwin", whichOf("wt.exe"), "/l", { powershell: true }), []);
});

test("Windows, shell powershell: wt.exe gets the PowerShell tab, the folder as cwd, the command only on the clipboard", async () => {
  const { d, spawned, clip } = deps();
  const proj = fresh();
  const line = H.bundledLaunchCommand("claude", "win32", "C:\\Program Files\\Atomic Agent\\resources\\atomic-agent.exe");
  assert.equal(line, "& 'C:\\Program Files\\Atomic Agent\\resources\\atomic-agent.exe' launch claude");
  const res = await O.openOtherTerminalWithCommand({ command: line, cwd: proj, shell: "powershell" }, d);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, "windows-terminal");
  assert.match(res.hint, /Ctrl\+V, then press Enter/);
  assert.deepEqual(clip, [line]);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, PS_TAB);
  assert.equal(spawned[0].cwd, proj);
});

test("Windows: no shell, or any other value, keeps the default profile (code blocks are unchanged)", async () => {
  for (const shell of [undefined, "cmd", "pwsh; calc", 1]) {
    const { d, spawned } = deps();
    await O.openOtherTerminalWithCommand({ command: "dir", cwd: null, shell }, d);
    assert.deepEqual(spawned[0].args, ["-d", "."], String(shell));
  }
});

test("Windows: no Windows Terminal, PowerShell itself in its own console", async () => {
  const { d, spawned } = deps({ which: whichOf("powershell.exe") });
  const res = await O.openOtherTerminalWithCommand({ command: "claude --resume abc-123", cwd: null, shell: "powershell" }, d);
  assert.equal(res.terminal, "powershell");
  assert.deepEqual(spawned[0].args, ["-NoLogo", "-NoExit"]);
  assert.equal(spawned[0].newConsole, true);
});

test("hostile folder names and launch paths stay out of the argv and stay quoted", async () => {
  const parent = fresh();
  const evil = join(parent, "a; new-tab cmd -k calc & $(touch x) 'q' `w`");
  mkdirSync(evil);
  const { d, spawned, clip } = deps();
  const line = H.bundledLaunchCommand("codex", "win32", "C:\\x'; calc; '\\atomic-agent.exe");
  assert.equal(line, "& 'C:\\x''; calc; ''\\atomic-agent.exe' launch codex", "a quote inside is doubled, so the path stays one string");
  const res = await O.openOtherTerminalWithCommand({ command: line, cwd: evil, shell: "powershell" }, d);
  assert.equal(res.ok, true);
  assert.equal(res.cwd, evil);
  assert.equal(spawned[0].cwd, evil, "the folder is the spawn's cwd");
  assert.deepEqual(spawned[0].args, PS_TAB, "constant argv: no folder, no command");
  assert.deepEqual(clip, [line]);
  assert.equal(H.bundledLaunchCommand("claude", "linux", "/opt/it's $HOME/atomic-agent"), "'/opt/it'\\''s $HOME/atomic-agent' launch claude");
  // Session ids that are not plain ids never become a command.
  for (const resumeId of ["x; calc", "$(calc)", "a`b", "a'b", "a&b", "-rf"]) {
    assert.equal(R.hubResumeCommand({ agent: "claude-code", resumeId }), "", resumeId);
  }
});

test("Linux: the hub's request (shell powershell ignored) runs the launcher in the row's folder", { skip: !posix }, async () => {
  const { d, spawned, clip } = deps({ platform: "linux" });
  const proj = fresh();
  const line = H.bundledLaunchCommand("claude", "linux", "/opt/Atomic Agent/resources/atomic-agent");
  const res = await O.openOtherTerminalWithCommand({ command: line, cwd: proj, shell: "powershell" }, d);
  assert.equal(res.ok, true);
  assert.equal(res.terminal, "x-terminal-emulator");
  assert.equal(spawned[0].args[0], "-e");
  assert.equal(spawned[0].args.length, 2);
  assert.equal(spawned[0].cwd, proj);
  assert.deepEqual(clip, [line]);
  assert.equal(readFileSync(join(spawned[0].args[1], "..", "cwd"), "utf8"), proj, "the launcher cds into the row's folder");
});

test("renderer: the Agents sheet offers Terminal on macOS, Windows and Linux, and asks for PowerShell", () => {
  const src = readFileSync(new URL("../renderer/agent-hub.js", import.meta.url), "utf8");
  assert.match(src, /const HUB_TERMINAL_PLATFORMS = \['darwin', 'win32', 'linux'\];/);
  assert.match(src, /BR\.terminalOpenWithCommand\(\{command, cwd: row\.cwd \|\| null, shell: 'powershell'\}\)/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /terminalOpenWithCommand: \(req: \{ command: string; cwd\?: string \| null; shell\?: "powershell" \}\)/);
});
