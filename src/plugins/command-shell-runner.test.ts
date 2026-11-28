import { describe, expect, it, vi } from "vitest";
import { ApprovalDeniedError } from "../approval/dangerous-tool.js";
import { currentApprovalWorkdir } from "../approval/approval-workdir.js";
import { mergePolicySources } from "../policy/policy-loader.js";
import { parsePolicyFile } from "../policy/policy-schema.js";
import { EMPTY_POLICY } from "../policy/policy-evaluator.js";
import type { CompressedToolResult } from "../compressor/result-compressor.js";
import { COMMAND_SHELL_TIMEOUT_MS, createRegistryShellRunner, shellOutputBody } from "./command-shell-runner.js";

const ok = (summary: string): CompressedToolResult => ({ tool: "os.shell.run", status: "ok", summary, details: {}, truncated: false });

describe("createRegistryShellRunner (ATO-2441)", () => {
  it("runs the line as one os.shell.run call in the chat's session and folder", async () => {
    let workdir: string | undefined;
    const invoke = vi.fn(async () => { workdir = currentApprovalWorkdir(); return ok("$ git diff\nexit: 0\n+a line"); });
    const run = createRegistryShellRunner({ registry: { invoke }, sessionId: "chat-1", workingDir: "/repo", policy: () => EMPTY_POLICY });
    await expect(run("git diff")).resolves.toBe("+a line");
    expect(invoke).toHaveBeenCalledWith("os.shell.run", { cmd: "git diff", timeoutMs: COMMAND_SHELL_TIMEOUT_MS },
      expect.objectContaining({ sessionId: "chat-1", workingDir: "/repo", modelMode: "cloud" }));
    // Approval rules scoped to a project see the chat's folder, as for a model's call.
    expect(workdir).toBe("/repo");
  });

  it("turns a denied approval into a refusal that names the line", async () => {
    const invoke = vi.fn(async () => { throw new ApprovalDeniedError("os.shell.run", undefined, { byUser: true }); });
    const run = createRegistryShellRunner({ registry: { invoke }, sessionId: "s", workingDir: "/r", policy: () => EMPTY_POLICY });
    await expect(run("git push")).rejects.toThrow("`git push` was not allowed");
  });

  it("refuses a line whose command failed", async () => {
    const invoke = vi.fn(async () => ({ ...ok("$ make\nexit: 2\nboom"), status: "error" as const }));
    const run = createRegistryShellRunner({ registry: { invoke }, sessionId: "s", workingDir: "/r", policy: () => EMPTY_POLICY });
    await expect(run("make")).rejects.toThrow(/`make` failed:\n[\s\S]*boom/);
  });

  it("never reaches the tool when the organization policy denies the line", async () => {
    const policy = mergePolicySources([{ status: { kind: "system", location: "test", state: "loaded" },
      file: parsePolicyFile({ rules: [{ action: "shell", resource: "curl *", effect: "deny" }] }) }]);
    const invoke = vi.fn(async () => ok("x"));
    const run = createRegistryShellRunner({ registry: { invoke }, sessionId: "s", workingDir: "/r", policy: () => policy });
    await expect(run("curl https://example.test")).rejects.toThrow("blocked by your organization's policy");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("shellOutputBody", () => {
  it("drops the shell result's own header and keeps a summary of another shape", () => {
    expect(shellOutputBody("note\n$ ls\nexit: 0\na\nb")).toBe("a\nb");
    expect(shellOutputBody("just text")).toBe("just text");
  });
});
