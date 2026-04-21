import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import type { ToolContext } from "../tool-registry.js";
import { buildOsFsEditTool } from "./fs-edit.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test-session",
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
    emit: (req) => gate.reject(req.approvalId, "denied by test"),
  });
  return gate;
}

describe("os.fs.edit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-edit-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces a unique substring after approval", async () => {
    const file = join(dir, "a.ts");
    await writeFile(file, "const x = 1;\nconst y = 2;\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { path: "a.ts", oldString: "const x = 1;", newString: "const x = 42;" },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe(
      "const x = 42;\nconst y = 2;\n",
    );
    expect(result.details.replacedOccurrences).toBe(1);
  });

  it("rejects non-unique oldString without replaceAll", async () => {
    const file = join(dir, "b.ts");
    await writeFile(file, "foo\nfoo\nbar\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "b.ts", oldString: "foo", newString: "baz" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/not unique/);
    expect(await readFile(file, "utf8")).toBe("foo\nfoo\nbar\n");
  });

  it("replaces every occurrence when replaceAll=true", async () => {
    const file = join(dir, "c.ts");
    await writeFile(file, "foo\nfoo\nbar\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: "c.ts",
        oldString: "foo",
        newString: "baz",
        replaceAll: true,
      },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("baz\nbaz\nbar\n");
    expect(result.details.replacedOccurrences).toBe(2);
  });

  it("rejects when oldString is not found", async () => {
    const file = join(dir, "d.ts");
    await writeFile(file, "alpha\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "d.ts", oldString: "beta", newString: "gamma" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/not found/);
  });

  it("rejects when oldString equals newString", async () => {
    const file = join(dir, "e.ts");
    await writeFile(file, "foo\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "e.ts", oldString: "foo", newString: "foo" },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/differ/);
  });

  it("honours approval denial and leaves the file intact", async () => {
    const file = join(dir, "f.ts");
    const original = "const x = 1;\n";
    await writeFile(file, original, "utf8");
    const tool = buildOsFsEditTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: "f.ts", oldString: "const x = 1;", newString: "const x = 2;" },
        makeCtx(dir),
      ),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("preserves multi-byte UTF-8 correctly", async () => {
    const file = join(dir, "utf8.ts");
    await writeFile(file, "магос благословенный\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: "utf8.ts",
        oldString: "магос",
        newString: "инициат",
      },
      makeCtx(dir),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(file, "utf8")).toBe("инициат благословенный\n");
  });

  it("leaves no orphaned temp files in the target directory", async () => {
    const file = join(dir, "g.ts");
    await writeFile(file, "one\n", "utf8");
    const tool = buildOsFsEditTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await tool.run(
      { path: "g.ts", oldString: "one", newString: "two" },
      makeCtx(dir),
    );
    const remaining = await readdir(dir);
    expect(remaining.filter((name) => name.endsWith(".atomic-agent.tmp"))).toEqual([]);
  });
});
