import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "../../tool-registry.js";
import type {
  ArchiveBackend,
  ArchiveEntry,
  ExtractReport,
} from "./archive-types.js";
import {
  ARCHIVE_SUMMARY_MAX_CHARS,
  buildOsFsArchiveListTool,
} from "./list-tool.js";

/**
 * A backend that reports `count` entries, so the listing caps can be
 * exercised without a multi-megabyte fixture in the repo.
 */
function fakeBackendListing(count: number): ArchiveBackend {
  const entries: ArchiveEntry[] = Array.from({ length: count }, (_, i) => ({
    path: `pkg/src/module-${String(i).padStart(4, "0")}/index.ts`,
    kind: "file",
    size: 1024 + i,
  }));
  return {
    format: "tar",
    list: () => Promise.resolve(entries),
    readEntry: () => Promise.reject(new Error("not used")),
    extract: () => Promise.reject<ExtractReport>(new Error("not used")),
  };
}

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

const FIXTURES = resolve(
  fileURLToPath(new URL("../test-fixtures", import.meta.url)),
);

describe("os.fs.archive.list", () => {
  it("lists zip entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run({ path: "sample.zip" }, makeCtx(FIXTURES));
    expect(result.status).toBe("ok");
    expect(result.summary).toMatch(/hello\.txt/);
    expect(result.summary).toMatch(/nested\/world\.txt/);
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("zip");
    expect(Array.isArray(details.entries)).toBe(true);
  });

  it("lists tar entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run({ path: "sample.tar" }, makeCtx(FIXTURES));
    expect(result.summary).toMatch(/hello\.txt/);
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("tar");
  });

  it("lists tar.gz entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run({ path: "sample.tar.gz" }, makeCtx(FIXTURES));
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("tar.gz");
  });

  it("lists gz (single synthetic entry)", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run({ path: "sample.txt.gz" }, makeCtx(FIXTURES));
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("gz");
    expect(details.entryCount).toBe(1);
  });

  it("rejects an unknown format", async () => {
    const tool = buildOsFsArchiveListTool();
    await expect(
      tool.run({ path: "sample.txt" }, makeCtx(FIXTURES)),
    ).rejects.toThrow(/could not detect format/);
  });

  it("honours a format override", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run(
      { path: "sample.tar", format: "tar" },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("tar");
  });

  it("keeps the head of a large listing and says how much it hid", async () => {
    const tool = buildOsFsArchiveListTool({
      backends: { tar: () => fakeBackendListing(400) },
    });
    const result = await tool.run(
      { path: "sample.tar", format: "tar" },
      makeCtx(FIXTURES),
    );

    // The first entries survive — a tail-slice would have dropped exactly
    // these, which is where a model looks first.
    expect(result.summary).toContain("pkg/src/module-0000/index.ts");
    expect(result.summary).toContain("pkg/src/module-0001/index.ts");
    // The clip is announced, with a count that adds up to the archive.
    const note = /… (\d+) more entries not shown/.exec(result.summary);
    expect(note).not.toBeNull();
    const rows = result.summary
      .split("\n")
      .filter((line) => line.startsWith("-")).length;
    expect(rows + Number(note![1])).toBe(400);
    expect(result.summary).not.toContain("[truncated]");
    // And it fits the budget, so nothing is cut a second time at render.
    expect(result.summary.length).toBeLessThanOrEqual(
      ARCHIVE_SUMMARY_MAX_CHARS,
    );

    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.entryCount).toBe(400);
  });

  it("leaves a listing that fits alone", async () => {
    const tool = buildOsFsArchiveListTool({
      backends: { tar: () => fakeBackendListing(20) },
    });
    const result = await tool.run(
      { path: "sample.tar", format: "tar" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toContain("pkg/src/module-0000/index.ts");
    expect(result.summary).toContain("pkg/src/module-0019/index.ts");
    expect(result.summary).not.toContain("not shown");
    expect(result.truncated).toBe(false);
  });
});
