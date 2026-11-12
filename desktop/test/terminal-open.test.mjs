// Unit tests for main/terminal-open.ts (ATO-1424), against the built output.
// Run: npm run build && npm run test:unit
// "Open in Terminal": the command is data in its own 0600 file, the launcher
// and the zsh hook are constant, `open -a Terminal` goes through execFile with
// an args array, and nothing is left behind.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../out/main/terminal-open.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato1424-")); dirs.push(d); return d; };
const mode = (p) => statSync(p).mode & 0o777;
const posix = process.platform !== "win32";

function deps(over = {}) {
  const calls = [];
  const home = fresh();
  return {
    calls,
    d: {
      platform: "darwin",
      home,
      root: join(fresh(), "atomic-agent-terminal"),
      execFile: async (file, args) => { calls.push({ file, args }); },
      ...over,
    },
  };
}

test("checkCommand: strings only, not empty, CRLF → LF, blank edges dropped", () => {
  assert.deepEqual(T.checkCommand(42), { ok: false, error: "invalid-request" });
  assert.deepEqual(T.checkCommand(undefined), { ok: false, error: "invalid-request" });
  assert.deepEqual(T.checkCommand(""), { ok: false, error: "empty-command" });
  assert.deepEqual(T.checkCommand(" \n\t\n"), { ok: false, error: "empty-command" });
  assert.deepEqual(T.checkCommand("\n\nls -la\r\necho hi\r\n\n"), { ok: true, text: "ls -la\necho hi" });
  assert.deepEqual(T.checkCommand("  ls"), { ok: true, text: "  ls" }, "a leading space is kept (HIST_IGNORE_SPACE)");
  assert.deepEqual(T.checkCommand("printf 'a\\tb'\tdone"), { ok: true, text: "printf 'a\\tb'\tdone" });
});

test("checkCommand: 64 KB cap in UTF-8 bytes", () => {
  assert.equal(T.TERMINAL_COMMAND_MAX_BYTES, 65536);
  assert.equal(T.checkCommand("a".repeat(65536)).ok, true);
  assert.deepEqual(T.checkCommand("a".repeat(65537)), { ok: false, error: "command-too-long" });
  // 3 bytes each: 21846 × 3 = 65538 bytes, under 64K characters but over the byte cap.
  assert.deepEqual(T.checkCommand("€".repeat(21846)), { ok: false, error: "command-too-long" });
});

test("checkCommand: terminal escapes and bidi overrides are refused", () => {
  for (const bad of ["echo \u001b]0;pwned\u0007", "ls\u0000", "rm\u007f", "a\u009bb", "echo ‮evil", "x⁦y", "a\u000bb", "a\u000cb"]) {
    assert.deepEqual(T.checkCommand(bad), { ok: false, error: "control-characters" }, JSON.stringify(bad));
  }
});

test("resolveFolder: an existing absolute folder, `~` expanded, anything else → home", () => {
  const home = fresh();
  mkdirSync(join(home, "proj"));
  writeFileSync(join(home, "file.txt"), "x");
  assert.deepEqual(T.resolveFolder(join(home, "proj"), home), { cwd: join(home, "proj"), usedHome: false });
  assert.deepEqual(T.resolveFolder("~/proj", home), { cwd: join(home, "proj"), usedHome: false });
  assert.deepEqual(T.resolveFolder("~", home), { cwd: home, usedHome: false });
  assert.deepEqual(T.resolveFolder(join(home, "missing"), home), { cwd: home, usedHome: true });
  assert.deepEqual(T.resolveFolder(join(home, "file.txt"), home), { cwd: home, usedHome: true });
  assert.deepEqual(T.resolveFolder("relative/dir", home), { cwd: home, usedHome: true });
  assert.deepEqual(T.resolveFolder(null, home), { cwd: home, usedHome: true });
  assert.deepEqual(T.resolveFolder(`${home}\n/etc`, home, () => true), { cwd: home, usedHome: true }, "newline in a path refused");
});

test("the launcher and the zsh hook are constant and never hold the command", () => {
  const root = join(fresh(), "r");
  const cmd = `echo "hi $(whoami)"; ls\nprintf '%s\\n' done`;
  const a = T.writeLaunchFiles(root, cmd, "/tmp");
  const b = T.writeLaunchFiles(root, "something else", "/");
  assert.notEqual(a.dir, b.dir);
  assert.equal(readFileSync(a.launcher, "utf8"), T.LAUNCHER_SCRIPT);
  assert.equal(readFileSync(b.launcher, "utf8"), T.LAUNCHER_SCRIPT);
  assert.equal(readFileSync(join(a.dir, "zdot", ".zshenv"), "utf8"), T.ZSHENV_SCRIPT);
  assert.equal(readFileSync(join(a.dir, "cmd"), "utf8"), cmd, "the command is stored as is");
  assert.equal(readFileSync(join(a.dir, "cwd"), "utf8"), "/tmp");
  assert.ok(!T.LAUNCHER_SCRIPT.includes("whoami") && !T.ZSHENV_SCRIPT.includes("whoami"));
  // The command reaches the input line raw (print -r) and only from the file.
  assert.match(T.ZSHENV_SCRIPT, /print -rz -- "\$\(<"\$d\/cmd"\)"/);
  assert.match(T.LAUNCHER_SCRIPT, /^#!\/bin\/sh\n/);
  assert.match(T.LAUNCHER_SCRIPT, /exec "\$user_shell" -l -i/);
  assert.match(T.LAUNCHER_SCRIPT, /pbcopy < "\$here\/cmd"/);
  assert.match(T.LAUNCHER_SCRIPT, /Press Cmd\+V/);
  assert.ok(!/osascript|tell application/i.test(T.LAUNCHER_SCRIPT + T.ZSHENV_SCRIPT), "no AppleScript");
});

test("file modes: folders 0700, data 0600, launcher 0700", { skip: !posix }, () => {
  const root = join(fresh(), "r");
  const f = T.writeLaunchFiles(root, "ls", "/tmp");
  assert.equal(mode(root), 0o700);
  assert.equal(mode(f.dir), 0o700);
  assert.equal(mode(join(f.dir, "cmd")), 0o600);
  assert.equal(mode(join(f.dir, "cwd")), 0o600);
  assert.equal(mode(join(f.dir, "zdot")), 0o700);
  assert.equal(mode(join(f.dir, "zdot", ".zshenv")), 0o600);
  assert.equal(mode(f.launcher), 0o700);
  assert.ok(f.dir.startsWith(join(root, T.LAUNCH_DIR_PREFIX)));
});

test("openTerminalWithCommand: open -a Terminal <launcher>, args array, answer names the folder", async () => {
  const { d, calls } = deps();
  mkdirSync(join(d.home, "chat"));
  const res = await T.openTerminalWithCommand({ command: "ls -la", cwd: join(d.home, "chat") }, d);
  assert.deepEqual(res, { ok: true, cwd: join(d.home, "chat"), usedHome: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/open");
  assert.equal(calls[0].args.length, 3);
  assert.deepEqual(calls[0].args.slice(0, 2), ["-a", "Terminal"]);
  assert.match(calls[0].args[2], /atomic-terminal-[^/\\]+[/\\]open\.command$/);
  assert.equal(readFileSync(calls[0].args[2], "utf8"), T.LAUNCHER_SCRIPT);
  const launchDir = join(calls[0].args[2], "..");
  assert.equal(readFileSync(join(launchDir, "cmd"), "utf8"), "ls -la");
});

test("openTerminalWithCommand: a missing folder opens in home", async () => {
  const { d } = deps();
  const res = await T.openTerminalWithCommand({ command: "pwd", cwd: "/no/such/folder/ato1424" }, d);
  assert.deepEqual(res, { ok: true, cwd: d.home, usedHome: true });
});

test("openTerminalWithCommand: not macOS → unsupported, nothing written or run", async () => {
  for (const platform of ["win32", "linux"]) {
    const { d, calls } = deps({ platform });
    const res = await T.openTerminalWithCommand({ command: "ls" }, d);
    assert.equal(res.ok, false);
    assert.equal(res.error, "unsupported");
    assert.equal(typeof res.message, "string");
    assert.equal(calls.length, 0);
    assert.equal(existsSync(d.root), false);
  }
});

test("openTerminalWithCommand: bad input is refused before anything is written", async () => {
  for (const [payload, error] of [[null, "invalid-request"], ["ls", "invalid-request"], [{}, "invalid-request"], [{ command: "" }, "empty-command"], [{ command: "x".repeat(70000) }, "command-too-long"], [{ command: "echo \u001b[2J" }, "control-characters"]]) {
    const { d, calls } = deps();
    const res = await T.openTerminalWithCommand(payload, d);
    assert.equal(res.ok, false, JSON.stringify(payload).slice(0, 40));
    assert.equal(res.error, error);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(d.root), false);
  }
});

test("openTerminalWithCommand: when open fails, the launch folder is removed", async () => {
  const { d } = deps({ execFile: async () => { throw new Error("Unable to find application named 'Terminal'"); } });
  const res = await T.openTerminalWithCommand({ command: "ls" }, d);
  assert.equal(res.ok, false);
  assert.equal(res.error, "open-failed");
  assert.match(res.message, /Terminal/);
  assert.deepEqual(readdirSync(d.root), []);
});

test("sweepLaunchDirs: only our old launch folders go", () => {
  const root = fresh();
  const old = join(root, `${T.LAUNCH_DIR_PREFIX}old`);
  const recent = join(root, `${T.LAUNCH_DIR_PREFIX}new`);
  const other = join(root, "keep-me");
  for (const p of [old, recent, other]) mkdirSync(p);
  writeFileSync(join(old, "cmd"), "ls");
  const past = new Date(Date.now() - 2 * 60_000);
  utimesSync(old, past, past);
  utimesSync(other, past, past);
  assert.equal(T.sweepLaunchDirs(root, T.SWEEP_AT_START_MS), 1);
  assert.deepEqual(readdirSync(root).sort(), ["atomic-terminal-new", "keep-me"]);
  assert.equal(T.sweepLaunchDirs(join(root, "missing"), 0), 0, "a missing root is fine");
});

// The zsh hook in a real zsh (macOS and most Linux CI have one): the person's
// .zshenv still loads, ZDOTDIR is handed back, the folder is entered, the
// command lands raw in the edit buffer (read -z pops it), and the launch
// folder is gone.
let haveZsh = false;
try { execFileSync("zsh", ["-fc", "true"], { stdio: "ignore" }); haveZsh = true; } catch { /* no zsh */ }

test("zsh hook: types the command raw, multi-line, without running it", { skip: !haveZsh }, () => {
  const base = fresh();
  const home = join(base, "home");
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, ".zshenv"), "export FROM_USER_ZSHENV=yes\n");
  const marker = join(base, "ran");
  const cmd = `echo "hi $(whoami)"; ls\nprintf '%s\\n' "\\n" > ${marker}`;
  const f = T.writeLaunchFiles(join(base, "root"), cmd, proj);
  const out = execFileSync("zsh", ["-c", [
    'print -r -- "zshenv=$FROM_USER_ZSHENV zdotdir=${ZDOTDIR-unset}"',
    "for f in $precmd_functions; do $f; done",
    "read -rz buf",
    'print -r -- "pwd=$PWD"',
    'print -rn -- "$buf"',
  ].join("\n")], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, ZDOTDIR: join(f.dir, "zdot"), ATOMIC_TERMINAL_DIR: f.dir, ATOMIC_USER_ZDOTDIR: "" },
    encoding: "utf8",
  });
  const [first, second, ...rest] = out.split("\n");
  assert.equal(first, "zshenv=yes zdotdir=unset");
  assert.match(second, /pwd=.*[/\\]home[/\\]proj$/);
  assert.equal(rest.join("\n"), cmd);
  assert.equal(existsSync(marker), false, "nothing was run");
  assert.equal(existsSync(f.dir), false, "launch folder deleted");
});
