import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../approval/approval-gate.js";
import { runWithToolHooks, ToolHookEngine } from "./hook-engine.js";
import { parseHooksObject } from "./hook-config.js";
import type { HookRunResult } from "./hook-runner.js";
import type { HookCommand } from "./hook-types.js";
import { notificationMessageFor, notificationTypeFor, PermissionHooks } from "./permission-hooks.js";
import { SessionHookEngine } from "./session-hook-engine.js";

const source = { kind: "user" as const, file: "/s/hooks.json" };
const loaded = (raw: unknown) => () => parseHooksObject(raw, source);
const result = (over: Partial<HookRunResult> = {}): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over });
const entry = (command: string, matcher = "") => [{ matcher, hooks: [{ type: "command", command }] }];
const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: "a1", sessionId: "s1", tool: "os.shell.run", category: "shell", reason: "run git push", workdir: "/work",
  commandArgv: ["git", "push"], ...over,
});

function setup(hooks: Record<string, unknown>, answers: Record<string, Partial<HookRunResult>> = {}) {
  const inputs: Record<string, Record<string, unknown>> = {};
  const run = vi.fn(async (hook: HookCommand, input: unknown) => {
    inputs[hook.command] = input as Record<string, unknown>;
    return result(answers[hook.command] ?? {});
  });
  const engine = new SessionHookEngine({ stateDir: "/s", load: loaded({ hooks }), run });
  return { hooks: new PermissionHooks(engine), run, inputs, engine };
}

describe("PermissionRequest / Notification hooks (ATO-2462)", () => {
  it("a PermissionRequest exit 2 refuses with stderr as the reason, matched on the Claude tool name", async () => {
    const { hooks, inputs } = setup({ PermissionRequest: entry("guard", "Bash") }, { guard: { exitCode: 2, stderr: "no pushes on Friday" } });
    expect(await hooks.beforePrompt(request())).toBe("no pushes on Friday");
    expect(inputs.guard).toMatchObject({
      hook_event_name: "PermissionRequest", session_id: "s1", cwd: "/work", tool_name: "Bash", atomic_tool_name: "os.shell.run",
      tool_input: { command: "git push" }, atomic_category: "shell",
    });
  });

  it("an allow from the hook does not approve: the prompt still goes out", async () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    const { hooks } = setup({ PermissionRequest: entry("yes") }, { yes: { stdout } });
    expect(await hooks.beforePrompt(request())).toBeUndefined();
  });

  it("a clarifying question is not a permission: no PermissionRequest", async () => {
    const { hooks, run } = setup({ PermissionRequest: entry("guard") }, { guard: { exitCode: 2 } });
    expect(await hooks.beforePrompt(request({ category: "user_question", tool: "ask_user" }))).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("the tool's real arguments reach tool_input when the call is in scope", async () => {
    const { hooks, inputs } = setup({ PermissionRequest: entry("guard") });
    const call = { tool: "os.fs.write", args: { path: "/work/a.txt", content: "x" }, sessionId: "s1", cwd: "/work", signal: new AbortController().signal };
    const toolHooks = new ToolHookEngine({ stateDir: "/s", load: loaded({ hooks: {} }), run: async () => result() });
    await runWithToolHooks(toolHooks, call, async () => {
      await hooks.beforePrompt(request({ tool: "os.fs.write", category: "fs_write_workspace", commandArgv: [] }));
      return { tool: "os.fs.write", status: "ok", summary: "", details: {}, truncated: false };
    });
    expect(inputs.guard?.tool_input).toMatchObject({ path: "/work/a.txt", file_path: "/work/a.txt" });
  });

  it("Notification fires when the prompt goes out, matched on notification_type", async () => {
    const { hooks, inputs, run } = setup({ Notification: [...entry("ping", "permission_prompt"), ...entry("ask", "elicitation_dialog")] });
    hooks.onPrompt(request());
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(inputs.ping).toMatchObject({
      hook_event_name: "Notification", notification_type: "permission_prompt", message: "Atomic Agent needs your permission to use Bash",
    });
    expect(inputs.ask).toBeUndefined();
  });

  it("names what the person is asked", () => {
    expect(notificationTypeFor({ category: "user_question" })).toBe("elicitation_dialog");
    expect(notificationTypeFor({ category: "fs_write_workspace" })).toBe("permission_prompt");
    expect(notificationMessageFor({ category: "user_question", tool: "ask_user" })).toBe("Atomic Agent has a question for you");
  });
});
