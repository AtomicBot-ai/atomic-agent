import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2111: the person's security rules review a command a fusion
 * worker's fan-out scope would otherwise run without the gate.
 */
describe.skipIf(process.platform === "win32")("os.shell.run: security rules on a fan-out shortcut (ATO-2111)", () => {
  let dir: string;
  let gate: ApprovalGate;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-guard-"));
    gate = new ApprovalGate({ level: 1, emit: () => undefined });
    gate.setSessionPolicy("worker", { onPrompt: "refuse", reason: "hand it back" });
    gate.fanoutScopes.grant("worker", [dir]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: "worker", stepIndex: 0, signal: new AbortController().signal };
  }

  it("a block refuses the command and it does not run", async () => {
    gate.setGuard({
      rules: () => ({ sets: [{ source: "user", rules: "Block creating files." }], tools: new Set(["os.shell.run"]), onFailure: "ask" }),
      review: async () => ({ decision: "block", reason: "creates a file" }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    await expect(tool.run({ cmd: "touch", args: ["made.txt"] }, ctx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
      byUser: false,
      message: expect.stringContaining("Blocked by your security rules: creates a file"),
    });
    await expect(stat(join(dir, "made.txt"))).rejects.toThrow();
  });

  it("an allow lets the scope run it as before", async () => {
    gate.setGuard({
      rules: () => ({ sets: [{ source: "user", rules: "Block deleting files." }], tools: new Set(["os.shell.run"]), onFailure: "ask" }),
      review: async () => ({ decision: "allow", reason: "" }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run({ cmd: "touch", args: ["made.txt"] }, ctx());
    expect(result.status).toBe("ok");
    await expect(stat(join(dir, "made.txt"))).resolves.toBeTruthy();
  });
});

describe.skipIf(process.platform === "win32")("os.shell.run: security rules on trusted read-only tools (ATO-2111)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-guard-trusted-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
  }

  it.each([
    [{ cmd: "icalBuddy", args: ["eventsToday"] }],
    [{ cmd: "gh", args: ["api", "repos/org/private"] }],
  ])("a block refuses %j, which the shell guard trusts and runs unasked", async (call) => {
    const reviewed: string[] = [];
    const gate = new ApprovalGate({ level: 1, emit: () => undefined });
    gate.setGuard({
      rules: () => ({
        sets: [{ source: "user", rules: "Never read my calendar or call GitHub." }],
        tools: new Set(["os.shell.run"]),
        onFailure: "ask",
      }),
      review: async (request) => {
        reviewed.push(request.tool);
        return { decision: "block", reason: "reads private data" };
      },
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    await expect(tool.run(call, ctx())).rejects.toMatchObject({
      name: "ApprovalDeniedError",
      byUser: false,
      message: expect.stringContaining("Blocked by your security rules: reads private data"),
    });
    expect(reviewed).toEqual(["os.shell.run"]);
  });
});
