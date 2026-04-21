import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { osFsReadTool } from "./fs-read.js";
import { osFsListTool } from "./fs-list.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { buildOsShellTool } from "./shell.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

describe("os.fs tools", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-os-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("os.fs.read returns file contents", async () => {
    await writeFile(join(dir, "hello.txt"), "привет, магос", "utf8");
    const result = await osFsReadTool.run({ path: "hello.txt" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("привет, магос");
  });

  it("os.fs.list enumerates directory entries", async () => {
    await writeFile(join(dir, "a.txt"), "a", "utf8");
    await mkdir(join(dir, "sub"));
    const result = await osFsListTool.run({ path: "." }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("a.txt");
    expect(result.summary).toContain("sub");
  });

  it("os.fs.write refuses to run without approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => {
        gate.reject(req.approvalId, "denied by test");
      },
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run(
        { path: "out.txt", content: "hello" },
        makeCtx(dir),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("os.fs.write writes after approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsFsWriteTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { path: "out.txt", content: "hello" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    const written = await readFile(join(dir, "out.txt"), "utf8");
    expect(written).toBe("hello");
  });
});

describe("os.shell.run", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires approval", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "no"),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    await expect(
      tool.run({ cmd: "echo", args: ["hi"] }, makeCtx(dir)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
  });

  it("executes echo and captures stdout when approved", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    const tool = buildOsShellTool({ approvals: gate, approvalRequired: true });
    const result = await tool.run(
      { cmd: "node", args: ["-e", "process.stdout.write('hi')"] },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("hi");
    expect(result.details.exitCode).toBe(0);
  });
});
