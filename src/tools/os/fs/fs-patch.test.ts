import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { createPatch } from "diff";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsPatchTool } from "./fs-patch.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePatchFiles(
  value: unknown,
): asserts value is [Record<string, unknown>, ...Record<string, unknown>[]] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) {
    throw new Error("expected a non-empty patch file report");
  }
}

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
    requirePatchFiles(result.details.files);
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
    ).rejects.toThrow(/The user declined/);
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

    requirePatchFiles(result.details.files);
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

describe("os.fs.patch with the *** Begin Patch format", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-codex-patch-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const exists = async (path: string): Promise<boolean> =>
    stat(path).then(() => true, () => false);

  const multiFile = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "@@ function main() {",
    "-  return 1;",
    "+  return 2;",
    "*** Add File: docs/notes.md",
    "+# Notes",
    "*** Delete File: stale.txt",
    "*** Update File: old-name.txt",
    "*** Move to: new-name.txt",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  async function seed(): Promise<void> {
    await writeFile(join(dir, "stale.txt"), "remove me\n", "utf8");
    await writeFile(join(dir, "old-name.txt"), "old\n", "utf8");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.ts"), "function main() {\n  return 1;\n}\n", "utf8");
  }

  it("detects the format and dry-runs every file without touching disk", async () => {
    await seed();
    const tool = buildOsFsPatchTool({ approvals: denyAll(), approvalRequired: true });
    const result = await tool.run({ patch: multiFile }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("dry-run");
    requirePatchFiles(result.details.files);
    expect(result.details.files.map((f) => [f.path, f.applied, f.action])).toEqual([
      ["src/app.ts", true, "update"],
      ["docs/notes.md", true, "add"],
      ["stale.txt", true, "delete"],
      ["new-name.txt", true, "update"],
      ["old-name.txt", true, "delete"],
    ]);
    expect(result.summary).toContain("(new file)");
    expect(result.summary).toContain("(moved from old-name.txt)");
    expect(result.summary).toContain("(moved to new-name.txt)");
    expect(await exists(join(dir, "stale.txt"))).toBe(true);
    expect(await exists(join(dir, "docs"))).toBe(false);
  });

  it("applies add, update, delete and move after one approval", async () => {
    await seed();
    const tool = buildOsFsPatchTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run({ patch: multiFile, apply: true }, makeCtx(dir));
    expect(result.status).toBe("ok");
    expect(result.details.mode).toBe("applied");
    expect(await readFile(join(dir, "src", "app.ts"), "utf8")).toBe(
      "function main() {\n  return 2;\n}\n",
    );
    expect(await readFile(join(dir, "docs", "notes.md"), "utf8")).toBe("# Notes\n");
    expect(await exists(join(dir, "stale.txt"))).toBe(false);
    expect(await exists(join(dir, "old-name.txt"))).toBe(false);
    expect(await readFile(join(dir, "new-name.txt"), "utf8")).toBe("new\n");
  });

  it("writes nothing when the approval is declined", async () => {
    await seed();
    const tool = buildOsFsPatchTool({ approvals: denyAll(), approvalRequired: true });
    await expect(tool.run({ patch: multiFile, apply: true }, makeCtx(dir))).rejects.toThrow(
      /The user declined/,
    );
    expect(await exists(join(dir, "stale.txt"))).toBe(true);
    expect(await exists(join(dir, "docs"))).toBe(false);
  });

  it("refuses the whole patch when one hunk misses, writing nothing", async () => {
    await seed();
    const patch = multiFile.replace("-old\n+new", "-not in the file\n+new");
    const tool = buildOsFsPatchTool({ approvals: approveAll(), approvalRequired: true });
    const result = await tool.run({ patch, apply: true }, makeCtx(dir));
    expect(result.status).toBe("error");
    expect(result.details.mode).toBe("apply-refused");
    requirePatchFiles(result.details.files);
    const failed = result.details.files.find((f) => f.applied === false);
    expect(failed?.path).toBe("old-name.txt");
    expect(String(failed?.reason)).toMatch(/hunk 1: these lines were not found/);
    expect(await readFile(join(dir, "src", "app.ts"), "utf8")).toContain("return 1;");
    expect(await exists(join(dir, "stale.txt"))).toBe(true);
    expect(await exists(join(dir, "docs"))).toBe(false);
  });

  it("reports a malformed envelope as a parse error", async () => {
    const tool = buildOsFsPatchTool({ approvals: approveAll(), approvalRequired: true });
    await expect(
      tool.run({ patch: "*** Begin Patch\n*** Update File: a.txt\n*** End Patch" }, makeCtx(dir)),
    ).rejects.toThrow(/os\.fs\.patch: failed to parse the \*\*\* Begin Patch format — line 2: .* has no hunks/);
  });

  it("honours an explicit format and rejects an unknown one", async () => {
    const tool = buildOsFsPatchTool({ approvals: approveAll(), approvalRequired: true });
    await expect(
      tool.run({ patch: "--- a/x\n+++ b/x\n", format: "codex" }, makeCtx(dir)),
    ).rejects.toThrow(/must start with "\*\*\* Begin Patch"/);
    await expect(
      tool.run({ patch: multiFile, format: "git" }, makeCtx(dir)),
    ).rejects.toThrow('os.fs.patch: `format` must be "auto", "unified" or "codex"');
  });

  it("refuses a masked secret marker before asking for approval", async () => {
    await writeFile(join(dir, ".env"), "TOKEN=real\n", "utf8");
    const patch = [
      "*** Begin Patch",
      "*** Update File: .env",
      "-TOKEN=real",
      "+TOKEN=[redacted:api_key]",
      "*** End Patch",
    ].join("\n");
    const tool = buildOsFsPatchTool({ approvals: denyAll(), approvalRequired: true });
    await expect(tool.run({ patch, apply: true }, makeCtx(dir))).rejects.toThrow(/masked secret/);
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("TOKEN=real\n");
  });
});
