import { describe, expect, it } from "vitest";
import type { HookRunResult } from "./hook-runner.js";
import type { HookCommand } from "./hook-types.js";
import { combineSessionVerdicts, interpretSessionHookRun } from "./session-hook-output.js";

const hook: HookCommand = { type: "command", command: "h", timeoutMs: 5_000, source: { kind: "user", file: "/s/hooks.json" } };
const run = (over: Partial<HookRunResult>): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over });

describe("session hook output", () => {
  it("UserPromptSubmit exit 2 blocks the prompt with stderr as the reason", () => {
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ exitCode: 2, stderr: "no secrets in prompts" }))).toEqual({ block: "no secrets in prompts" });
  });

  it("UserPromptSubmit plain stdout and additionalContext are context", () => {
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ stdout: "branch: main\n" }))).toEqual({ context: "branch: main" });
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ticket ATO-1" } });
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ stdout: json }))).toEqual({ context: "ticket ATO-1" });
  });

  it("UserPromptSubmit JSON decision block and continue:false refuse", () => {
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ stdout: JSON.stringify({ decision: "block", reason: "off hours" }) }))).toEqual({ block: "off hours" });
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ stdout: JSON.stringify({ continue: false, stopReason: "paused" }) }))).toEqual({ block: "paused" });
  });

  it("Stop exit 2 or decision block asks to keep working; plain stdout is ignored", () => {
    expect(interpretSessionHookRun("Stop", hook, run({ exitCode: 2, stderr: "tests are red" }))).toEqual({ block: "tests are red" });
    expect(interpretSessionHookRun("Stop", hook, run({ stdout: JSON.stringify({ decision: "block", reason: "run lint" }) }))).toEqual({ block: "run lint" });
    expect(interpretSessionHookRun("Stop", hook, run({ stdout: "done" }))).toEqual({});
    expect(interpretSessionHookRun("Stop", hook, run({ stdout: JSON.stringify({ decision: "block", continue: false }) }))).toEqual({});
  });

  it("SessionStart and PreCompact cannot block: exit 2 is only an error", () => {
    const start = interpretSessionHookRun("SessionStart", hook, run({ exitCode: 2, stderr: "nope" }));
    expect(start.block).toBeUndefined();
    expect(start.error).toContain("cannot block");
    expect(interpretSessionHookRun("PreCompact", hook, run({ exitCode: 2, stderr: "nope" })).block).toBeUndefined();
    expect(interpretSessionHookRun("SessionStart", hook, run({ stdout: "welcome back" }))).toEqual({ context: "welcome back" });
    expect(interpretSessionHookRun("PreCompact", hook, run({ stdout: "saved a backup" }))).toEqual({});
  });

  it("timeouts and other exits are errors, never blocks", () => {
    expect(interpretSessionHookRun("Stop", hook, run({ timedOut: true, exitCode: null })).block).toBeUndefined();
    expect(interpretSessionHookRun("UserPromptSubmit", hook, run({ exitCode: 1, stderr: "boom" }))).toEqual({ error: expect.stringContaining("exit code 1") });
  });

  it("any block wins when several hooks ran; contexts are joined", () => {
    expect(combineSessionVerdicts([{ context: "a" }, { block: "b" }, { context: "c" }])).toEqual({ block: "b", context: "a\nc" });
  });
});
