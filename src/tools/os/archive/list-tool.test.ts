import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsArchiveListTool } from "./list-tool.js";

function makeCtx(workingDir: string): ToolContext {
  return {
    workingDir,
    sessionId: "test",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

const FIXTURES = resolve(
  new URL("../test-fixtures", import.meta.url).pathname,
);

describe("os.fs.archive.list", () => {
  it("lists zip entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run(
      { path: "sample.zip" },
      makeCtx(FIXTURES),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toMatch(/hello\.txt/);
    expect(result.summary).toMatch(/nested\/world\.txt/);
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("zip");
    expect(Array.isArray(details.entries)).toBe(true);
  });

  it("lists tar entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run(
      { path: "sample.tar" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toMatch(/hello\.txt/);
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("tar");
  });

  it("lists tar.gz entries", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run(
      { path: "sample.tar.gz" },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.format).toBe("tar.gz");
  });

  it("lists gz (single synthetic entry)", async () => {
    const tool = buildOsFsArchiveListTool();
    const result = await tool.run(
      { path: "sample.txt.gz" },
      makeCtx(FIXTURES),
    );
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
});
