// ATO-1428: "Open in Terminal" never runs anything by itself and does not
// break on hard commands. Against the built main/terminal-open.js (ATO-1424).
// Run: npm run build && node --test test/terminal-open-tricky.test.mjs
//
// For every command in TRICKY, through the real route with execFile mocked:
//   - the text lands only in the launch folder's `cmd` file, byte for byte;
//   - `open` gets exactly `-a Terminal <launcher>`, with no piece of the text;
//   - the launcher and the zsh hook are the constant scripts;
//   - nothing the command would do has happened (marker files absent).
// With a real zsh on the machine, the hook then puts the same bytes into the
// input line and still nothing runs. Folder names get the same treatment.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../out/main/terminal-open.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "ato1428-")); dirs.push(d); return d; };

let haveZsh = false;
try { execFileSync("zsh", ["-fc", "true"], { stdio: "ignore" }); haveZsh = true; } catch { /* no zsh */ }

/**
 * Commands that would leave a marker file if any shell ran them. `M` is the
 * markers folder, swapped in per test. Each entry: [name, command].
 */
const TRICKY = [
  ["single and double quotes", `echo 'single "inner"' "double 'inner'" && touch M/quotes`],
  ["unbalanced quote", `echo "it's; touch M/unbalanced`],
  ["command substitution", `echo $(touch M/subst) "$(touch M/subst2)"`],
  ["backticks", "echo `touch M/backtick` \"`touch M/backtick2`\""],
  ["semicolon", "true; touch M/semicolon"],
  ["and / or / pipe", "true && touch M/and || touch M/or | tee M/pipe"],
  ["backslashes", "printf '%s\\n' 'a\\b' C:\\\\Users\\\\x \\\ntouch M/continued"],
  ["newlines", "touch M/line1\ntouch M/line2\n\ntouch M/line4"],
  ["heredoc", "cat <<'EOF' > M/heredoc\n$(touch M/heredoc-subst)\nEOF"],
  ["variables and globs", "echo $HOME ${USER:-x} ~ * ?? [ab] {1..3} && touch M/vars"],
  ["history and job chars", "echo !! !$ ^a^b % & touch M/hist"],
  ["leading dash and spaces", "  -rf --help; touch M/dash"],
  ["redirections", "> M/redir1 < /dev/null 2>&1 >> M/redir2"],
  ["unicode", "echo \"привет 世界 🚀 naïve café\" > M/unicode"],
  ["tabs", "printf 'a\\tb'\t> M/tab"],
  ["applescript lookalike", `osascript -e 'tell application "Terminal" to do script "touch M/osa"'`],
];

function deps() {
  const calls = [];
  return {
    calls,
    d: {
      platform: "darwin",
      home: fresh(),
      root: join(fresh(), "atomic-agent-terminal"),
      execFile: async (file, args) => { calls.push({ file, args: [...args] }); },
    },
  };
}

function withMarkers(command) {
  const markers = fresh();
  return { markers, text: command.replaceAll("M/", markers + "/") };
}

/** Pieces of `text` long enough to be recognisable if they leaked somewhere. */
function pieces(text) {
  return text.split(/[\n\t ]+/).filter((p) => p.length >= 4);
}

/** Runs our zsh hook the way the first prompt would and returns the input line. */
function zshInputLine(dir, home) {
  const out = execFileSync("zsh", ["-c", [
    "for f in $precmd_functions; do $f; done",
    "read -rz buf",
    'print -r -- "pwd=$PWD"',
    'print -rn -- "$buf"',
  ].join("\n")], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, ZDOTDIR: join(dir, "zdot"), ATOMIC_TERMINAL_DIR: dir, ATOMIC_USER_ZDOTDIR: "" },
    encoding: "utf8",
  });
  const nl = out.indexOf("\n");
  return { pwd: out.slice(4, nl), line: out.slice(nl + 1) };
}

for (const [name, command] of TRICKY) {
  test(`tricky command (${name}): only in the cmd file, nothing run`, async () => {
    const { markers, text } = withMarkers(command);
    const expected = T.checkCommand(text);
    assert.equal(expected.ok, true, `${name} is accepted`);
    const { d, calls } = deps();
    const res = await T.openTerminalWithCommand({ command: text, cwd: d.home }, d);
    assert.deepEqual(res, { ok: true, cwd: d.home, usedHome: false });

    assert.equal(calls.length, 1);
    const [{ file, args }] = calls;
    assert.equal(file, "/usr/bin/open");
    assert.equal(args.length, 3);
    assert.deepEqual(args.slice(0, 2), ["-a", "Terminal"]);
    const launchDir = join(args[2], "..");
    assert.ok(args[2].startsWith(d.root), "the launcher sits in our temp root");
    for (const piece of pieces(text)) {
      assert.ok(!args.some((a) => a.includes(piece)), `open args hold ${JSON.stringify(piece)}`);
    }

    assert.equal(readFileSync(join(launchDir, "cmd"), "utf8"), expected.text, "byte for byte");
    assert.equal(readFileSync(args[2], "utf8"), T.LAUNCHER_SCRIPT);
    assert.equal(readFileSync(join(launchDir, "zdot", ".zshenv"), "utf8"), T.ZSHENV_SCRIPT);
    assert.deepEqual(readdirSync(launchDir).sort(), ["cmd", "cwd", "open.command", "zdot"]);
    assert.deepEqual(readdirSync(markers), [], "nothing ran");
  });
}

test("tricky commands typed by the real zsh hook: same bytes, still nothing run", { skip: !haveZsh }, () => {
  for (const [name, command] of TRICKY) {
    const { markers, text } = withMarkers(command);
    const home = fresh();
    const f = T.writeLaunchFiles(join(fresh(), "root"), T.checkCommand(text).text, home);
    const { line } = zshInputLine(f.dir, home);
    assert.equal(line, T.checkCommand(text).text, name);
    assert.deepEqual(readdirSync(markers), [], `${name}: nothing ran`);
    assert.equal(existsSync(f.dir), false, `${name}: launch folder deleted`);
  }
});

test("tricky folder names: opened as is, never in open's args, never run", async () => {
  const names = [`proj $(touch M/dir-subst)`, "it's \"q\"", "back`touch M/dir-bt`tick", "a;b && c", "папка 世界 🚀", "-rf"];
  for (const raw of names) {
    const { markers, text: folderName } = withMarkers(raw);
    const { d, calls } = deps();
    const folder = join(d.home, folderName.replaceAll("/", "_"));
    mkdirSync(folder);
    const res = await T.openTerminalWithCommand({ command: "pwd", cwd: folder }, d);
    assert.deepEqual(res, { ok: true, cwd: folder, usedHome: false }, raw);
    assert.equal(calls[0].args.length, 3);
    assert.ok(!calls[0].args.some((a) => a.includes(folderName.replaceAll("/", "_"))), `${raw}: folder not in args`);
    const launchDir = join(calls[0].args[2], "..");
    assert.equal(readFileSync(join(launchDir, "cwd"), "utf8"), folder);
    if (haveZsh) {
      const { pwd, line } = zshInputLine(launchDir, d.home);
      assert.match(pwd, new RegExp(folderName.replaceAll("/", "_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), raw);
      assert.equal(line, "pwd");
    }
    assert.deepEqual(readdirSync(markers), [], `${raw}: nothing ran`);
  }
});

test("refused before anything is written: blank, too long, hidden characters", async () => {
  const cases = [
    ["spaces only", "     ", "empty-command"],
    ["tabs and newlines only", "\t \n\r\n \t", "empty-command"],
    ["unicode spaces only", "\u00a0\u2003\u3000", "empty-command"],
    ["over 64 KB of ASCII", "a".repeat(64 * 1024 + 1), "command-too-long"],
    ["over 64 KB of two-byte letters", "я".repeat(32 * 1024 + 1), "command-too-long"],
    ["over 64 KB of emoji", "🚀".repeat(16 * 1024 + 1), "command-too-long"],
    ["escape sequence", "echo \u001b[31mred", "control-characters"],
    ["carriage-return trick after text", "ls\rrm -rf ~", null],
    ["right-to-left override", "echo \u202eevil", "control-characters"],
  ];
  for (const [name, command, error] of cases) {
    const { d, calls } = deps();
    const res = await T.openTerminalWithCommand({ command }, d);
    if (error === null) {
      // A lone CR is turned into a newline, so both lines show; nothing hides the second.
      assert.equal(res.ok, true, name);
      const launchDir = join(calls[0].args[2], "..");
      assert.equal(readFileSync(join(launchDir, "cmd"), "utf8"), "ls\nrm -rf ~", name);
      continue;
    }
    assert.equal(res.ok, false, name);
    assert.equal(res.error, error, name);
    assert.equal(typeof res.message, "string");
    assert.equal(calls.length, 0, `${name}: open not called`);
    assert.equal(existsSync(d.root), false, `${name}: nothing written`);
  }
});

test("exactly at the 64 KB cap is still accepted, in full", async () => {
  const text = "é".repeat(32 * 1024); // 2 bytes each = 65536 bytes
  const { d, calls } = deps();
  const res = await T.openTerminalWithCommand({ command: text }, d);
  assert.equal(res.ok, true);
  assert.equal(readFileSync(join(calls[0].args[2], "..", "cmd"), "utf8"), text);
});
