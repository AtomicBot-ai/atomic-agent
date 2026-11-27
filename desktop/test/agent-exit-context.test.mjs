// ATO-2416: main/sentry/agent-exit-context.ts, against the built output (npm run build first).
// The closing lines are serve's own fixed wording (src/cli/serve-command.ts, serve-memory-guard.ts);
// everything after that wording here is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../out/main/sentry/agent-exit-context.js");
const R = require("../out/main/sentry/exit-reason.js");

test("serve's own closing lines become one word from the closed list", () => {
  const cases = [
    ["[atomic-agent] SIGTERM received, closing", "sigterm"],
    ["[atomic-agent] SIGINT received, closing", "sigint"],
    ["[atomic-agent] SIGHUP received, closing", "sighup"],
    ["[atomic-agent] parent exited and no turn is running, closing", "parent_exited"],
    ["[atomic-agent] parent exited; finishing the turn in flight before closing", "parent_exited_busy"],
    ["[atomic-agent] memory guard: closing the agent cleanly before the system runs out of memory", "memory_guard"],
    ["serve failed: Error: listen EADDRINUSE /Users/someone/x", "serve_failed"],
    // The ring's stderr mark in front of a line does not hide it.
    ["![atomic-agent] SIGTERM received, closing", "sigterm"],
  ];
  for (const [line, want] of cases) {
    assert.equal(C.agentCloseWord(line), want, line);
    assert.ok(C.AGENT_CLOSE_WORDS.includes(want));
  }
});

test("any other line, or the wording inside someone's text, is no close word", () => {
  for (const line of [
    "[atomic-agent] serve listening on http://127.0.0.1:4317 (auth=bearer, cwd=/x)",
    "[atomic-agent] memory ok rss_mb=300 heap_mb=120",
    "user said: [atomic-agent] SIGTERM received, closing",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "",
  ]) assert.equal(C.agentCloseWord(line), null, line);
});

test("the newest close word wins; a line that says none keeps the one before", () => {
  let w = null;
  w = C.nextCloseWord(w, "[atomic-agent] serve listening on http://127.0.0.1:1 (auth=bearer, cwd=/x)");
  assert.equal(w, null);
  w = C.nextCloseWord(w, "[atomic-agent] parent exited; finishing the turn in flight before closing");
  assert.equal(w, "parent_exited_busy");
  w = C.nextCloseWord(w, "some log line");
  assert.equal(w, "parent_exited_busy");
  w = C.nextCloseWord(w, "[atomic-agent] parent exited and no turn is running, closing");
  assert.equal(w, "parent_exited");
});

test("stopped_by: the system ending the session first, then what serve said, else self", () => {
  assert.equal(C.stoppedBy(null, true), "os");
  assert.equal(C.stoppedBy("sigterm", true), "os");
  assert.equal(C.stoppedBy("sigterm", false), "outside_signal");
  assert.equal(C.stoppedBy("sigint", false), "outside_signal");
  assert.equal(C.stoppedBy("parent_exited", false), "parent_gone");
  assert.equal(C.stoppedBy("parent_exited_busy", false), "parent_gone");
  assert.equal(C.stoppedBy("memory_guard", false), "memory_guard");
  assert.equal(C.stoppedBy("serve_failed", false), "boot_failed");
  assert.equal(C.stoppedBy(null, false), "self");
});

test("turns in flight are a bucket, never the count", () => {
  assert.equal(C.turnsBucket(0), "0");
  assert.equal(C.turnsBucket(1), "1");
  assert.equal(C.turnsBucket(5), "gt_1");
  assert.equal(C.turnsBucket(null), null);
  assert.equal(C.turnsBucket(-1), null);
});

test("Windows STATUS_CONTROL_C_EXIT reads ctrl_c_exit", () => {
  assert.equal(R.windowsExitStatus(0xc000013a), "ctrl_c_exit");
  assert.equal(R.windowsExitStatus(3221225786), "ctrl_c_exit");
  assert.equal(R.agentExitStatus(0xc000013a), "ctrl_c_exit");
});
