import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { osFsReadTool } from "./fs-read.js";
import { osFsListTool } from "./fs-list.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { buildOsShellTool } from "./shell.js";
import { registerOsTools } from "./index.js";

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

  it("os.fs.read supports offset and limit for line-range reads", async () => {
    await writeFile(
      join(dir, "multiline.txt"),
      "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      "utf8",
    );
    const result = await osFsReadTool.run(
      { path: "multiline.txt", offset: 2, limit: 2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("beta\ngamma");
    expect(result.details.startLine).toBe(2);
    expect(result.details.endLine).toBe(3);
    expect(result.details.totalLines).toBe(5);
    expect(result.details.returnedLines).toBe(2);
  });

  it("os.fs.read prefixes LINE_NUMBER| when lineNumbers=true", async () => {
    await writeFile(join(dir, "three.txt"), "one\ntwo\nthree\n", "utf8");
    const result = await osFsReadTool.run(
      { path: "three.txt", lineNumbers: true, offset: 2, limit: 2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe(`${"2".padStart(6, " ")}|two\n${"3".padStart(6, " ")}|three`);
  });

  it("os.fs.read treats negative offset as counting from the end", async () => {
    await writeFile(
      join(dir, "tail.txt"),
      "l1\nl2\nl3\nl4\nl5\n",
      "utf8",
    );
    const result = await osFsReadTool.run(
      { path: "tail.txt", offset: -2 },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toBe("l4\nl5");
    expect(result.details.startLine).toBe(4);
    expect(result.details.endLine).toBe(5);
  });

  it("os.fs.read keeps byte-mode behaviour unchanged when no range specified", async () => {
    await writeFile(join(dir, "plain.txt"), "one\ntwo\n", "utf8");
    const result = await osFsReadTool.run({ path: "plain.txt" }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.totalLines).toBeUndefined();
    expect(result.summary).toContain("one");
    expect(result.summary).toContain("two");
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

describe("registerOsTools", () => {
  it("registers the full OS tool surface", () => {
    const registry = new ToolRegistry();
    const gate = new ApprovalGate({ emit: () => undefined });
    registerOsTools(registry, {
      approvals: gate,
      approvalRequired: false,
      config: {
        http: {
          enabled: true,
          approvalMode: "writes",
          hostAllowlist: null,
          maxResponseBytes: 1_048_576,
          defaultTimeoutMs: 30_000,
        },
      },
    });
    const names = registry.list().map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "os.clipboard.read",
        "os.clipboard.write",
        "os.fs.archive.extract",
        "os.fs.archive.list",
        "os.fs.archive.read_entry",
        "os.fs.diff",
        "os.fs.edit",
        "os.fs.glob",
        "os.fs.grep",
        "os.fs.hash",
        "os.fs.list",
        "os.fs.patch",
        "os.fs.read",
        "os.fs.read_document",
        "os.fs.watch",
        "os.fs.write",
        "os.git.blame",
        "os.git.branch",
        "os.git.diff",
        "os.git.log",
        "os.git.show",
        "os.git.status",
        "os.http.request",
        "os.notify",
        "os.proc.kill",
        "os.proc.list",
        "os.shell.run",
        "os.window.focus",
        "os.window.list",
      ].sort(),
    );
  });
});
