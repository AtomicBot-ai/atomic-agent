// ATO-1014: Hand off to Claude Code / Codex. main/handoff-out.ts is checked
// against the built output (npm run build first); the pure half of
// renderer/handoff-out.js is loaded as a CommonJS module, like handoff.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/handoff-out.js");
const R = require("../renderer/handoff-out.js");

const BRIEF = "# Handoff: Fix the login\n\nContinued from an Atomic Agent chat for Claude Code.\n\n"
  + "- Folder: `/Users/me/work/app`\n- Atomic Agent chat: `abc`\n\n## Task\n\n> fix it\n";

test("argv: only claude or codex, a sane chat id, an absolute --out", () => {
  assert.deepEqual(M.handoffOutArgs("claude", "3f2a-uuid", "/s/handoffs/3f2a-uuid-claude.md"), {
    ok: true, args: ["handoff", "--to", "claude", "--session", "3f2a-uuid", "--out", "/s/handoffs/3f2a-uuid-claude.md"],
  });
  assert.equal(M.handoffOutArgs("codex", "hermes:20260511_162944_79a9e8", "/s/x.md").ok, true);
  assert.equal(M.handoffOutArgs("opencode", "abc", "/s/x.md").ok, false);
  assert.equal(M.handoffOutArgs("claude-code", "abc", "/s/x.md").ok, false);
  for (const bad of ["--yes", "-x", "a b", "a;rm -rf ~", "$(id)", "a'b", "", 7, null]) {
    assert.equal(M.handoffOutArgs("claude", bad, "/s/x.md").ok, false, String(bad));
  }
  assert.equal(M.handoffOutArgs("claude", "abc", "relative.md").ok, false);
  assert.equal(M.handoffOutArgs("claude", "abc", "/s/a\nb.md").ok, false);
});

test("the brief file: one per chat and target, a colon in the id made safe", () => {
  assert.equal(M.handoffOutFile("/s/handoffs", "claude", "abc"), "/s/handoffs/abc-claude.md");
  assert.equal(M.handoffOutFile("/s/handoffs", "codex", "hermes:2026_1"), "/s/handoffs/hermes_2026_1-codex.md");
});

test("terminal command: the path single-quoted, the brief never in the line", () => {
  assert.equal(M.shellQuote("/a b/c"), "'/a b/c'");
  assert.equal(M.shellQuote("/it's"), "'/it'\\''s'");
  assert.equal(M.handoffTerminalCommand("claude", "/Users/me/Library/Application Support/Atomic Agent/handoffs/abc-claude.md"),
    `claude "$(cat '/Users/me/Library/Application Support/Atomic Agent/handoffs/abc-claude.md')"`);
  assert.equal(M.handoffTerminalCommand("codex", "/t/x.md"), `codex "$(cat '/t/x.md')"`);
  // A hostile path still comes back as one literal word from sh.
  const nasty = "/t/$(touch pwned)'`id`\";x.md";
  const out = execFileSync("/bin/sh", ["-c", `printf %s ${M.shellQuote(nasty)}`], { encoding: "utf8" });
  assert.equal(out, nasty);
});

test("output: reads the brief, the folder from it, Terminal only on macOS", () => {
  const ok = { ok: true, stdout: "", stderr: "Wrote the Claude Code handoff for chat abc to /s/abc-claude.md\n" };
  const mac = M.parseHandoffOut(ok, { to: "claude", path: "/s/abc-claude.md", brief: BRIEF, platform: "darwin" });
  assert.equal(mac.ok, true);
  assert.equal(mac.label, "Claude Code");
  assert.equal(mac.brief, BRIEF);
  assert.equal(mac.folder, "/Users/me/work/app");
  assert.deepEqual(mac.terminal, { command: `claude "$(cat '/s/abc-claude.md')"`, cwd: "/Users/me/work/app" });
  const win = M.parseHandoffOut(ok, { to: "codex", path: "C:\\s\\abc-codex.md", brief: BRIEF, platform: "win32" });
  assert.equal(win.ok, true);
  assert.equal(win.terminal, null);
  const long = BRIEF + "x".repeat(M.TERMINAL_BRIEF_MAX_BYTES);
  const big = M.parseHandoffOut(ok, { to: "claude", path: "/s/a.md", brief: long, platform: "darwin" });
  assert.equal(big.terminal, null);
  assert.ok(big.preview.length < 1300 && big.preview.endsWith("…"));
  assert.equal(M.parseHandoffOut(ok, { to: "claude", path: "/s/a.md", brief: null, platform: "darwin" }).ok, false);
});

test("output: failures in words; an agent without --to is told to update", () => {
  const missing = M.parseHandoffOut({ ok: false, stdout: "", stderr: "No Atomic Agent chat with id zz.\n", error: "exit 1" },
    { to: "claude", path: "/s/a.md", brief: null, platform: "darwin" });
  assert.deepEqual(missing, { ok: false, error: "No Atomic Agent chat with id zz." });
  for (const stderr of ["unknown flag: --to\n", "unknown command: handoff\n"]) {
    const old = M.parseHandoffOut({ ok: false, stdout: "", stderr, error: "exit 2" }, { to: "claude", path: "/s/a.md", brief: null, platform: "darwin" });
    assert.deepEqual(old, { ok: false, error: M.HANDOFF_OUT_TOO_OLD });
  }
});

test("run: refused on a remote agent, writes into the handoffs folder, Reveal only what it wrote", async () => {
  const calls = [];
  const deps = {
    run: async (args) => { calls.push(args); return { ok: true, stdout: "", stderr: "" }; },
    remote: () => false,
    dir: () => "/s/handoffs",
    platform: "darwin",
    mkdir: () => {},
    readFile: () => BRIEF,
  };
  const remote = await M.handoffOut({ ...deps, remote: () => true }, "claude", "abc");
  assert.deepEqual(remote, { ok: false, error: M.HANDOFF_OUT_REMOTE });
  assert.equal(calls.length, 0);
  assert.equal((await M.handoffOut(deps, "claude", "--help")).ok, false);
  assert.equal(calls.length, 0);
  const res = await M.handoffOut(deps, "codex", "abc");
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ["handoff", "--to", "codex", "--session", "abc", "--out", "/s/handoffs/abc-codex.md"]);
  const shown = [];
  assert.deepEqual(M.handoffReveal((p) => shown.push(p), "/s/handoffs/abc-codex.md"), { ok: true });
  assert.equal(M.handoffReveal((p) => shown.push(p), "/etc/passwd").ok, false);
  assert.deepEqual(shown, ["/s/handoffs/abc-codex.md"]);
});

test("renderer: chat text is escaped in the result block", () => {
  const html = R.houtResultHTML({ ok: true, path: "/s/<b>.md", preview: "# Handoff: <img src=x onerror=alert(1)> & \"q\" 'a'" });
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<b>"));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot; &#39;a&#39;/);
  assert.equal(R.houtResultHTML({ ok: false, error: "x" }), "");
  assert.equal(R.houtLabel("codex"), "Codex");
  assert.equal(R.houtLabel("nope"), "Claude Code");
  assert.match(R.houtCaption("codex", false), /paste it into Codex/);
  assert.match(R.houtCaption("claude", true), /nothing runs until you press Enter/);
});

test("renderer: Open in Terminal only when main gave a command and the bridge exists", () => {
  const res = { ok: true, terminal: { command: "claude \"$(cat '/s/a.md')\"", cwd: "/w" } };
  const br = { terminalOpenWithCommand: () => {} };
  assert.equal(R.houtTerminalOk(res, br), true);
  assert.equal(R.houtTerminalOk({ ...res, terminal: null }, br), false);
  assert.equal(R.houtTerminalOk(res, {}), false);
  assert.equal(R.houtTerminalOk(null, br), false);
});

test("hooks: palette row, chat menu item, sheet, act, preload, main and index.html", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.match(src, /\['arrowR','Hand off to Claude Code \/ Codex…','','','houtopen'\]/);
  assert.match(src, /if \(S\.overlay === 'hout'\) html \+= handoffOutSheetHTML\(\);/);
  assert.match(src, /if \(k === 'houtopen' \|\| k === 'hout'\) \{ if \(k === 'houtopen'\) \{ close\(\); S\.settings = null; \} handoffOutAct\(k, v \|\| ''\); render\(\); return; \}/);
  const list = require("../renderer/chat-list.js");
  assert.ok(list.chatMenuItems({ exportable: true }).some((i) => i.verb === "houtopen"));
  assert.ok(!list.chatMenuItems({ exportable: false }).some((i) => i.verb === "houtopen"));
  const pre = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  assert.match(pre, /handoffTo: \(to: string, sessionId: string\) => ipcRenderer\.invoke\("cli:handoffTo", to, sessionId\)/);
  assert.match(pre, /handoffReveal: \(path: string\) => ipcRenderer\.invoke\("cli:handoffReveal", path\)/);
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  assert.match(main, /import \{ registerHandoffOutIpc \} from "\.\/handoff-out\.js";/);
  assert.match(main, /registerHandoffOutIpc\(\{ ipcMain, run: atagRun, remote: \(\) => client\.isRemote,/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = html.indexOf('src="handoff-out.js"');
  assert.ok(at > 0 && at < html.indexOf('src="renderer.js"'));
});
