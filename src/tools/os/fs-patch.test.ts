import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../approval/approval-gate.js";
import { createPatch } from "diff";
import type { ToolContext } from "../tool-registry.js";
import { buildOsFsPatchTool } from "./fs-patch.js";

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
    emit: (req) => gate.reject(req.approvalId, "denied"),
  });
  return gate;
}

describe("os.fs.patch", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-patch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function buildPatch(label: string, oldText: string, newText: string): string {
    return createPatch(label, oldText, newText);
  }

  it("dry-runs a valid patch without touching disk", async () => {
    const file = join(dir, "sacred.txt");
    const original = "line one\nline two\nline three\n";
    const updated = "line one\nline TWO\nline three\nline four\n";
    await writeFile(file, original, "utf8");
    const patch = buildPatch("sacred.txt", original, updated);

    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch }, makeCtx(dir));

    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("dry-run");
    expect(result.details.files[0].applied).toBe(true);
    expect(result.details.files[0].addedLines).toBe(2);
    expect(result.details.files[0].removedLines).toBe(1);
    // Disk still has original content.
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("applies a patch after approval", async () => {
    const file = join(dir, "sacred.txt");
    const original = "alpha\nbeta\ngamma\n";
    const updated = "alpha\nBETA\ngamma\ndelta\n";
    await writeFile(file, original, "utf8");
    const patch = buildPatch("sacred.txt", original, updated);

    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch, apply: true }, makeCtx(dir));

    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("applied");
    expect(await readFile(file, "utf8")).toBe(updated);
  });

  it("refuses to apply if approval denied", async () => {
    const file = join(dir, "s.txt");
    const original = "x\n";
    const updated = "y\n";
    await writeFile(file, original, "utf8");
    const patch = buildPatch("s.txt", original, updated);

    const tool = buildOsFsPatchTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run({ patch, apply: true }, makeCtx(dir)),
    ).rejects.toThrow(/approval denied/);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("reports fuzz-mismatch hunks as not-applied in dry-run", async () => {
    const file = join(dir, "drift.txt");
    // File state is slightly different from what the patch was built against.
    await writeFile(file, "one\ntwo drifted\nthree\n", "utf8");
    const patchFromClean = buildPatch(
      "drift.txt",
      "one\ntwo\nthree\n",
      "one\n2\nthree\n",
    );

    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch: patchFromClean }, makeCtx(dir));

    expect(result.details.files[0].applied).toBe(false);
    expect(result.details.files[0].reason).toMatch(/did not match/);
    expect(result.details.anyFailed).toBe(true);
  });

  it("refuses whole apply when any hunk cannot land (no partial writes)", async () => {
    const file = join(dir, "x.txt");
    await writeFile(file, "wrong content\n", "utf8");
    const patch = buildPatch("x.txt", "real content\n", "updated content\n");
    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch, apply: true }, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.details.mode).toBe("apply-refused");
    expect(await readFile(file, "utf8")).toBe("wrong content\n");
  });

  it("warns when an applied patch leaves a JSON file unparseable", async () => {
    const file = join(dir, "config.json");
    const original = '{\n  "a": 1\n}\n';
    const updated = '{\n  "a": 1\n  "b": 2\n}\n';
    await writeFile(file, original, "utf8");
    const patch = buildPatch("config.json", original, updated);
    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch, apply: true }, makeCtx(dir));
    // The patch still lands; the warning rides on top of the report.
    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("applied");
    expect(await readFile(file, "utf8")).toBe(updated);
    const warning = result.summary.split("\n")[0]!;
    expect(warning).toMatch(
      /^⚠ config\.json does not parse after this patch: SyntaxError: .*\(line 3 column 3\)\. It parsed before the patch/,
    );
    expect(result.details.parseWarning).toBe(warning);
    expect(result.summary).toContain("patch applied:");
  });

  it("stays silent when an applied patch keeps a JS file parsing", async () => {
    const file = join(dir, "app.js");
    const original = "function a() {\n  return 1;\n}\n";
    const updated = "function a() {\n  return 2;\n}\n";
    await writeFile(file, original, "utf8");
    const patch = buildPatch("app.js", original, updated);
    const tool = buildOsFsPatchTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run({ patch, apply: true }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).not.toContain("⚠");
    expect(result.details.parseWarning).toBeUndefined();
  });
});
