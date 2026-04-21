import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsProcKillTool } from "./proc-kill.js";

function makeCtx(): ToolContext {
  return {
    workingDir: process.cwd(),
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.reject(req.approvalId, "denied"),
  });
  return gate;
}

describe("os.proc.kill", () => {
  let child: ChildProcess | null = null;

  beforeEach(() => {
    child = null;
  });
  afterEach(() => {
    if (child && child.pid !== undefined) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  function spawnVictim(): ChildProcess {
    // Long-lived subprocess we can safely send signals to. `sleep`
    // exists on all POSIX systems; on Windows we'd need a different
    // fixture, but the test suite is POSIX-only today.
    const c = spawn("sleep", ["60"], { stdio: "ignore" });
    child = c;
    return c;
  }

  it("sends SIGTERM and process dies", async () => {
    if (process.platform === "win32") return;
    const victim = spawnVictim();
    await new Promise((r) => setTimeout(r, 50));
    const tool = buildOsProcKillTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ pid: victim.pid! }, makeCtx());
    expect(result.status).toBe("ok");
    expect(result.details.success).toBe(true);
    await new Promise<void>((resolve) => {
      victim.once("exit", () => resolve());
      setTimeout(() => resolve(), 2000);
    });
    expect(victim.exitCode !== null || victim.signalCode !== null).toBe(true);
  });

  it("refuses when approval is denied", async () => {
    if (process.platform === "win32") return;
    const victim = spawnVictim();
    await new Promise((r) => setTimeout(r, 50));
    const tool = buildOsProcKillTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run({ pid: victim.pid! }, makeCtx()),
    ).rejects.toThrow(/approval denied/);
    expect(victim.killed).toBe(false);
  });

  it("rejects unknown signal names", async () => {
    const tool = buildOsProcKillTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run({ pid: 1, signal: "SIGNUKE" }, makeCtx()),
    ).rejects.toThrow(/unsupported signal/);
  });

  it("reports error when PID is invalid (approval-bypassed form)", async () => {
    const tool = buildOsProcKillTool({
      approvals: approveAll(),
      approvalRequired: false,
    });
    const result = await tool.run({ pid: 999999999 }, makeCtx());
    expect(result.status).toBe("error");
    expect(result.details.success).toBe(false);
  });
});
