import { describe, expect, it, vi } from "vitest";
import { ToolHookEngine, claudeShapedInput, hookInput, runWithToolHooks, type ToolHookCall } from "./hook-engine.js";
import { parseHooksObject } from "./hook-config.js";
import type { HookRunResult } from "./hook-runner.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";

const source = { kind: "user" as const, file: "/s/hooks.json" };
const loaded = (raw: unknown) => () => parseHooksObject(raw, source);
const call = (tool = "os.shell.run", args: unknown = { cmd: "rm", args: ["-rf", "/tmp/x"] }): ToolHookCall => ({
  tool, args, sessionId: "s1", cwd: "/work", signal: new AbortController().signal,
});
const ok: CompressedToolResult = { tool: "os.shell.run", status: "ok", summary: "done", details: {}, truncated: false };
const runResult = (over: Partial<HookRunResult>): HookRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1, ...over });
const pre = (matcher: string) => ({ hooks: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: "check" }] }] } });

describe("tool hook engine", () => {
  it("a deny becomes a refusal result and the tool never runs", async () => {
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Bash")), run: async () => runResult({ exitCode: 2, stderr: "no rm" }) });
    const invoke = vi.fn(async () => ok);
    const result = await runWithToolHooks(engine, call(), invoke);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.summary).toContain("os.shell.run was not run: a PreToolUse hook blocked it. Reason: no rm");
    expect(result.details).toMatchObject({ hookDenied: true, hookReason: "no rm" });
  });

  it("hooks whose matcher does not select the tool do not run", async () => {
    const run = vi.fn(async () => runResult({ exitCode: 2 }));
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Edit|Write")), run });
    const result = await runWithToolHooks(engine, call(), async () => ok);
    expect(run).not.toHaveBeenCalled();
    expect(result).toBe(ok);
  });

  it("ask goes to the approval gate; a denial reads as the user's", async () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "touches prod" } });
    const request = vi.fn(async () => ({ approvalId: "a", approved: false }));
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Bash")), run: async () => runResult({ stdout }), approvals: { request } });
    const invoke = vi.fn(async () => ok);
    const result = await runWithToolHooks(engine, call(), invoke);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tool: "os.shell.run", category: "hook_ask", reason: expect.stringContaining("touches prod") }), expect.anything());
    expect(invoke).not.toHaveBeenCalled();
    expect(result.details.errorName).toBe("ApprovalDeniedError");
    expect(result.summary).toContain("The user declined this os.shell.run call");
  });

  it("ask approved runs the tool", async () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } });
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Bash")), run: async () => runResult({ stdout }), approvals: { request: async () => ({ approvalId: "a", approved: true }) } });
    expect(await runWithToolHooks(engine, call(), async () => ok)).toEqual(ok);
  });

  it("ask with no approval gate is refused", async () => {
    const stdout = JSON.stringify({ hookSpecificOutput: { permissionDecision: "ask" } });
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Bash")), run: async () => runResult({ stdout }) });
    const result = await runWithToolHooks(engine, call(), async () => ok);
    expect(result.details.hookDenied).toBe(true);
  });

  it("a timed-out PreToolUse hook does not block; the error is attached", async () => {
    const engine = new ToolHookEngine({ stateDir: "/s", load: loaded(pre("Bash")), run: async () => runResult({ timedOut: true, exitCode: null }) });
    const result = await runWithToolHooks(engine, call(), async () => ok);
    expect(result.status).toBe("ok");
    expect(String(result.details.hookErrors)).toMatch(/timed out/);
  });

  it("PostToolUse feedback is appended for the model", async () => {
    const raw = { hooks: { PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "lint" }] }] } };
    const seen: unknown[] = [];
    const engine = new ToolHookEngine({
      stateDir: "/s",
      load: loaded(raw),
      run: async (_h, input) => { seen.push(input); return runResult({ exitCode: 2, stderr: "lint: 3 errors" }); },
    });
    const result = await runWithToolHooks(engine, call("os.fs.write", { path: "/work/a.ts", content: "x" }), async () => ({ ...ok, tool: "os.fs.write" }));
    expect(result.summary).toBe("done\n\n[PostToolUse hook] lint: 3 errors");
    expect(seen[0]).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Write", atomic_tool_name: "os.fs.write", tool_input: { file_path: "/work/a.ts" }, tool_response: { status: "ok", output: "done" } });
  });

  it("no engine means the tool runs untouched", async () => {
    expect(await runWithToolHooks(null, call(), async () => ok)).toBe(ok);
  });
});

describe("hook stdin", () => {
  it("carries both names and Claude-shaped keys", () => {
    const input = hookInput("PreToolUse", call());
    expect(input).toMatchObject({ session_id: "s1", cwd: "/work", hook_event_name: "PreToolUse", tool_name: "Bash", atomic_tool_name: "os.shell.run", claude_tool_name: "Bash" });
    expect((input.tool_input as Record<string, unknown>).command).toBe("rm -rf /tmp/x");
    expect(input).not.toHaveProperty("tool_response");
  });

  it("keeps our name as tool_name when Claude has none", () => {
    expect(hookInput("PreToolUse", call("browser.click", {})).tool_name).toBe("browser.click");
  });

  it("adds old_string / new_string for edits", () => {
    expect(claudeShapedInput("os.fs.edit", { path: "a", oldString: "x", newString: "y" })).toMatchObject({ file_path: "a", old_string: "x", new_string: "y" });
  });
});
