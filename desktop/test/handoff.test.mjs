// ATO-1156: Continue from Claude Code / Codex. main/handoff.ts is checked
// against the built output (npm run build first); the pure half of
// renderer/handoff.js is loaded as a CommonJS module, like chat-folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const M = require("../out/main/handoff.js");
const R = require("../renderer/handoff.js");

test("argv: only the two agents, a sane id, always --json", () => {
  assert.deepEqual(M.handoffListArgs("codex", 10), { ok: true, args: ["handoff", "--from", "codex", "--list", "--json", "--limit", "10"] });
  assert.deepEqual(M.handoffListArgs("claude-code", 999).args.at(-1), "15");
  assert.equal(M.handoffListArgs("hermes").ok, false);
  assert.deepEqual(M.handoffStartArgs("claude-code", "3f2a-uuid"), {
    ok: true, args: ["handoff", "--from", "claude-code", "--session", "3f2a-uuid", "--json"],
  });
  assert.equal(M.handoffStartArgs("claude-code", "--yes").ok, false);
  assert.equal(M.handoffStartArgs("claude-code", "a b").ok, false);
  assert.equal(M.handoffStartArgs("claude-code", 7).ok, false);
});

test("list: reads the last JSON line and drops malformed rows", () => {
  const stdout = "some notice\n" + JSON.stringify({
    from: "claude-code", sourceDir: "/h/.claude",
    sessions: [
      { agent: "claude-code", id: "abc", mtimeMs: 5, cwd: "/w/app", title: "Fix it", messageCount: 3 },
      { agent: "hermes", id: "x" },
      { agent: "claude-code", id: "--bad" },
    ],
  }) + "\n";
  const res = M.parseHandoffList({ ok: true, stdout, stderr: "" });
  assert.equal(res.ok, true);
  assert.equal(res.sourceDir, "/h/.claude");
  assert.deepEqual(res.sessions.map((s) => s.id), ["abc"]);
});

test("an agent without the command is told to update", () => {
  const res = M.parseHandoffList({ ok: false, stdout: "", stderr: "unknown command: handoff\n", error: "exit 2" });
  assert.deepEqual(res, { ok: false, error: M.HANDOFF_TOO_OLD });
});

test("start: the chat id and the prompt, or the agent's own error", () => {
  const ok = M.parseHandoffStart({ ok: true, stderr: "", stdout: JSON.stringify({
    ok: true, sessionId: "s-1", title: "Fix it (from Claude Code)", workingDir: "/w", prompt: "continue",
    turns: 12, closedCalls: 1, context: { windowTokens: 32768, compacted: true, tokensBefore: 90000, tokensAfter: 15000 },
  }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.sessionId, "s-1");
  assert.equal(ok.context.compacted, true);
  const missing = M.parseHandoffStart({ ok: false, stderr: "", stdout: JSON.stringify({ ok: false, error: "no Codex sessions found in /h/.codex" }) });
  assert.deepEqual(missing, { ok: false, error: "no Codex sessions found in /h/.codex" });
  assert.equal(M.parseHandoffStart({ ok: true, stderr: "", stdout: "{}" }).ok, false);
});

test("connected to another computer: refused in words, nothing run", async () => {
  let ran = false;
  const run = async () => { ran = true; return { ok: true, stdout: "", stderr: "" }; };
  assert.deepEqual(await M.handoffList(run, "codex", true), { ok: false, error: M.HANDOFF_REMOTE });
  assert.deepEqual(await M.handoffStart(run, "codex", "abc", true), { ok: false, error: M.HANDOFF_REMOTE });
  assert.equal(ran, false);
});

test("renderer rows: folder, when, how many", () => {
  assert.equal(R.handoffFolder("/Users/me/code/app/"), "app");
  assert.equal(R.handoffFolder(null), "");
  const meta = R.handoffRowMeta({ cwd: "/w/app", mtimeMs: 1, messageCount: 1 }, () => "yesterday");
  assert.equal(meta, "app · yesterday · 1 message");
  assert.match(R.handoffDoneText({ context: { compacted: true } }, "Codex"), /summarised to fit/);
  assert.doesNotMatch(R.handoffDoneText({ context: null }, "Codex"), /summarised/);
});
