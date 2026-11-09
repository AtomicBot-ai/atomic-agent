import { describe, expect, it } from "vitest";
import { combineVerdicts, interpretHookRun } from "./hook-output.js";
import type { HookRunResult } from "./hook-runner.js";
import type { HookCommand } from "./hook-types.js";

const hook: HookCommand = { type: "command", command: "./check.sh", timeoutMs: 60_000, source: { kind: "user", file: "/s/hooks.json" } };
const run = (over: Partial<HookRunResult>): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over });

describe("hook output", () => {
  it("exit 0 with no JSON is no decision", () => {
    expect(interpretHookRun("PreToolUse", hook, run({ stdout: "ok\n" }))).toEqual({ decision: "none" });
  });

  it("exit 2 blocks a PreToolUse with stderr as the reason", () => {
    expect(interpretHookRun("PreToolUse", hook, run({ exitCode: 2, stderr: "no rm -rf\n" }))).toEqual({ decision: "deny", reason: "no rm -rf" });
  });

  it("exit 2 on PostToolUse becomes feedback, not a deny", () => {
    expect(interpretHookRun("PostToolUse", hook, run({ exitCode: 2, stderr: "lint failed" }))).toEqual({ decision: "none", feedback: "lint failed" });
  });

  it("reads permissionDecision before the legacy decision field", () => {
    const stdout = JSON.stringify({ decision: "approve", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "prod path" } });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout }))).toEqual({ decision: "deny", reason: "prod path" });
  });

  it("reads ask, allow and decision: block", () => {
    const ask = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "sure?" } });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout: ask }))).toEqual({ decision: "ask", reason: "sure?" });
    const allow = JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout: allow }))).toEqual({ decision: "allow" });
    const block = JSON.stringify({ decision: "block", reason: "nope" });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout: block }))).toEqual({ decision: "deny", reason: "nope" });
  });

  it("continue: false stops the call", () => {
    const stdout = JSON.stringify({ continue: false, stopReason: "frozen" });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout }))).toEqual({ decision: "deny", reason: "frozen" });
  });

  it("PostToolUse additionalContext and block become feedback", () => {
    const stdout = JSON.stringify({ decision: "block", reason: "tests broke", hookSpecificOutput: { additionalContext: "see CI" } });
    expect(interpretHookRun("PostToolUse", hook, run({ stdout }))).toEqual({ decision: "none", feedback: "tests broke\nsee CI" });
  });

  it("timeouts, crashes and broken JSON are non-blocking errors", () => {
    expect(interpretHookRun("PreToolUse", hook, run({ timedOut: true, exitCode: null })).error).toMatch(/timed out after 60 s/);
    expect(interpretHookRun("PreToolUse", hook, run({ exitCode: 1, stderr: "boom" }))).toMatchObject({ decision: "none", error: expect.stringMatching(/exit code 1: boom/) });
    expect(interpretHookRun("PreToolUse", hook, run({ stdout: "{not json" }))).toMatchObject({ decision: "none", error: expect.stringMatching(/does not parse/) });
  });

  it("deny beats ask beats allow when several hooks ran", () => {
    expect(combineVerdicts([{ decision: "allow" }, { decision: "ask", reason: "a" }, { decision: "deny", reason: "d" }])).toEqual({ decision: "deny", reason: "d" });
    expect(combineVerdicts([{ decision: "allow" }, { decision: "ask", reason: "a" }]).decision).toBe("ask");
    expect(combineVerdicts([{ decision: "none", error: "x" }, { decision: "allow" }])).toEqual({ decision: "allow", error: "x" });
  });
});
