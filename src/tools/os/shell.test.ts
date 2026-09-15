import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsShellTool, isOpaqueInterpreterShape } from "./shell.js";

describe("isOpaqueInterpreterShape (shape-grant suppression)", () => {
  it("withholds [a] for shell interpreters whose danger lives in their args", () => {
    // `bash -c "<anything>"` and friends: the binary name hides what
    // runs, so a shape grant on them would silence arbitrary code.
    for (const shape of ["bash", "sh", "zsh", "dash", "ksh"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(true);
    }
  });

  it("allows [a] for ordinary binaries the shape name fully describes", () => {
    for (const shape of ["git", "npm", "ls", "cat", "curl", "rm", "docker"]) {
      expect(isOpaqueInterpreterShape(shape)).toBe(false);
    }
  });
});

describe("os.shell.run says when it ran with no arguments (F40)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-bare-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeCtx(): ToolContext {
    return {
      workingDir: dir,
      sessionId: "test-session",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  function tool() {
    const gate = new ApprovalGate({
      emit: (req) =>
        gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return buildOsShellTool({ approvals: gate, approvalRequired: true });
  }

  it("notes a bare invocation when args is absent", async () => {
    // The live case was `python3` with its script under an unknown key:
    // exit 0, nothing done, and nothing in the output said so.
    const result = await tool().run({ cmd: "echo" }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("$ echo (ran with no arguments)\nexit: 0");
  });

  it("notes a bare invocation when args is empty", async () => {
    const result = await tool().run({ cmd: "echo", args: [] }, makeCtx());
    expect(result.summary).toContain("$ echo (ran with no arguments)");
  });

  it("stays silent when arguments were passed", async () => {
    const result = await tool().run({ cmd: "echo", args: ["hi"] }, makeCtx());
    expect(result.summary).toContain("$ echo hi\nexit: 0");
    expect(result.summary).not.toContain("ran with no arguments");
  });

  it("stays silent on the subshell path, where the arguments live in cmd", async () => {
    const result = await tool().run({ cmd: "echo hi | cat" }, makeCtx());
    expect(result.summary).toContain("hi");
    expect(result.summary).not.toContain("ran with no arguments");
  });
});
