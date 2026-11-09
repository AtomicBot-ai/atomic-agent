import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import type { ArchiveBackend } from "./archive-types.js";
import { buildOsFsArchiveExtractTool } from "./extract-tool.js";

const FIXTURES = resolve(
  fileURLToPath(new URL("../test-fixtures", import.meta.url)),
);

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
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
    emit: (req) => gate.reject(req.approvalId, "denied by test"),
  });
  return gate;
}

describe("os.fs.archive.extract", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "archive-extract-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts a zip after approval", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { path: join(FIXTURES, "sample.zip"), destDir: dir },
      makeCtx(FIXTURES),
    );
    expect(result.status).toBe("ok");
    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe(
      "Hello from the archive.\n",
    );
  });

  it("extracts a tar.gz", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await tool.run(
      { path: join(FIXTURES, "sample.tar.gz"), destDir: dir },
      makeCtx(FIXTURES),
    );
    expect(await readFile(join(dir, "nested/world.txt"), "utf8")).toBe(
      "Nested payload.\n",
    );
  });

  it("asks as trust_config when the destination holds a trust path", async () => {
    const categories: string[] = [];
    const gate = new ApprovalGate({
      level: 4,
      emit: (req) => {
        categories.push(req.category);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsFsArchiveExtractTool({
      approvals: gate,
      approvalRequired: true,
      trustConfigPaths: [join(dir, "hooks.json")],
    });
    await tool.run(
      { path: join(FIXTURES, "sample.zip"), destDir: dir },
      makeCtx(FIXTURES),
    );
    expect(categories).toEqual(["trust_config"]);
  });

  it("asks as trust_config when the archive replaces the project's saved rules", async () => {
    const categories: string[] = [];
    const gate = new ApprovalGate({
      level: 4,
      emit: (req) => {
        categories.push(req.category);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const backend: ArchiveBackend = {
      format: "zip",
      list: async () => [{ path: ".atomic-agent/approval-rules.json", kind: "file" }],
      readEntry: async () => Buffer.alloc(0),
      extract: async () => ({ extractedEntries: 0, totalBytesWritten: 0, skippedEntries: [], warnings: [] }),
    };
    const tool = buildOsFsArchiveExtractTool({
      approvals: gate,
      approvalRequired: true,
      backends: { zip: () => backend },
    });
    await tool.run({ path: join(FIXTURES, "sample.zip"), destDir: dir }, makeCtx(dir));
    expect(categories).toEqual(["trust_config"]);
  });

  it("refuses when approval is denied", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run(
        { path: join(FIXTURES, "sample.zip"), destDir: dir },
        makeCtx(FIXTURES),
      ),
    ).rejects.toThrow(/The user declined/);
  });

  it("respects include filter", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: join(FIXTURES, "sample.zip"),
        destDir: dir,
        include: ["nested"],
      },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.extractedEntries).toBe(1);
    await expect(readFile(join(dir, "hello.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(dir, "nested/world.txt"), "utf8")).toBe(
      "Nested payload.\n",
    );
  });

  it("refuses to overwrite without opt-in", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await writeFile(join(dir, "hello.txt"), "existing", "utf8");
    const result = await tool.run(
      { path: join(FIXTURES, "sample.zip"), destDir: dir },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    const skipped = details.skippedEntries as Array<{ reason: string }>;
    expect(skipped.some((s) => /overwrite=false/.test(s.reason))).toBe(true);
    expect(await readFile(join(dir, "hello.txt"), "utf8")).toBe("existing");
  });

  it("honours custom limits", async () => {
    const tool = buildOsFsArchiveExtractTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      {
        path: join(FIXTURES, "sample.zip"),
        destDir: dir,
        limits: { maxTotalBytes: 1_000_000, maxEntryBytes: 3, maxEntries: 100 },
      },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    const skipped = details.skippedEntries as Array<{ reason: string }>;
    expect(
      skipped.some((s) => /entry_exceeds_max_entry_bytes/.test(s.reason)),
    ).toBe(true);
  });
});
