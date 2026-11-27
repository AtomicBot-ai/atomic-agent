import { describe, expect, it, vi } from "vitest";
import { parseHooksObject } from "./hook-config.js";
import type { HookRunResult } from "./hook-runner.js";
import type { HookCommand } from "./hook-types.js";
import { SessionHookEngine } from "./session-hook-engine.js";

const source = { kind: "user" as const, file: "/s/hooks.json" };
const loaded = (raw: unknown) => () => parseHooksObject(raw, source);
const result = (over: Partial<HookRunResult> = {}): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over });
const entry = (command: string, matcher = "") => [{ matcher, hooks: [{ type: "command", command }] }];
const turn = { sessionId: "s1", cwd: "/work", prompt: "fix the build", isNewSession: true };

/** A runner that answers per command and records the stdin each hook got. */
function runner(answers: Record<string, Partial<HookRunResult>>) {
  const inputs: Record<string, Record<string, unknown>> = {};
  const run = vi.fn(async (hook: HookCommand, input: unknown) => {
    inputs[hook.command] = input as Record<string, unknown>;
    return result(answers[hook.command] ?? {});
  });
  return { run, inputs };
}

describe("session hook engine", () => {
  it("UserPromptSubmit gets the prompt on stdin and its stdout becomes context", async () => {
    const { run, inputs } = runner({ ctx: { stdout: "on branch main" } });
    const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks: { UserPromptSubmit: entry("ctx") } }), run });
    expect(await engine.beforeTurn(turn)).toEqual({ kind: "proceed", context: "on branch main" });
    expect(inputs.ctx).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "fix the build", session_id: "s1", cwd: "/work" });
  });

  it("UserPromptSubmit exit 2 blocks the turn", async () => {
    const { run } = runner({ guard: { exitCode: 2, stderr: "no prod deploys on Friday" } });
    const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks: { UserPromptSubmit: entry("guard") } }), run });
    expect(await engine.beforeTurn(turn)).toEqual({ kind: "blocked", reason: "no prod deploys on Friday" });
  });

  it("SessionStart fires once per session, with startup or resume as source and matcher", async () => {
    const { run, inputs } = runner({ start: { stdout: "hello" } });
    const engine = new SessionHookEngine({
      stateDir: "/s",
      load: loaded({ hooks: { SessionStart: [...entry("start", "startup"), ...entry("resumed", "resume")] } }),
      run,
    });
    expect(await engine.beforeTurn(turn)).toEqual({ kind: "proceed", context: "hello" });
    expect(inputs.start).toMatchObject({ hook_event_name: "SessionStart", source: "startup" });
    expect(inputs.resumed).toBeUndefined();
    await engine.beforeTurn(turn);
    expect(run).toHaveBeenCalledTimes(1);
    await engine.beforeTurn({ ...turn, sessionId: "s2", isNewSession: false });
    expect(inputs.resumed).toMatchObject({ source: "resume", session_id: "s2" });
  });

  it("Stop returns the reason to keep working and passes stop_hook_active", async () => {
    const { run, inputs } = runner({ stop: { exitCode: 2, stderr: "tests are red" } });
    const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks: { Stop: entry("stop") } }), run });
    expect(await engine.afterTurn({ sessionId: "s1", cwd: "/work", lastReply: "Done.", stopHookActive: true })).toBe("tests are red");
    expect(inputs.stop).toMatchObject({ hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Done." });
  });

  it("a failing Stop hook does not keep the agent working", async () => {
    const warn = vi.fn();
    const { run } = runner({ stop: { exitCode: 1, stderr: "crash" } });
    const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks: { Stop: entry("stop") } }), run, logger: { warn } });
    expect(await engine.afterTurn({ sessionId: "s1", cwd: "/work", stopHookActive: false })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("hooks: hook failed", expect.objectContaining({ event: "Stop" }));
  });

  it("PreCompact runs with the trigger and instructions, matched on the trigger", async () => {
    const { run, inputs } = runner({});
    const engine = new SessionHookEngine({
      stateDir: "/s",
      load: loaded({ hooks: { PreCompact: [...entry("manual-only", "manual"), ...entry("auto-only", "auto")] } }),
      run,
    });
    await engine.beforeCompact({ sessionId: "s1", cwd: "/work", trigger: "manual", instructions: "keep the plan" });
    expect(inputs["manual-only"]).toMatchObject({ hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "keep the plan" });
    expect(inputs["auto-only"]).toBeUndefined();
  });

  it("no hooks configured: nothing runs and the turn proceeds", async () => {
    const run = vi.fn();
    const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks: {} }), run });
    expect(await engine.beforeTurn(turn)).toEqual({ kind: "proceed" });
    expect(run).not.toHaveBeenCalled();
  });
});
