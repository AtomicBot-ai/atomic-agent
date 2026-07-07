import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsArchiveReadEntryTool } from "./read-entry-tool.js";

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

describe("os.fs.archive.read_entry", () => {
  it("reads a zip entry as UTF-8", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    const result = await tool.run(
      { path: "sample.zip", entry: "hello.txt" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toContain("Hello from the archive.");
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.encoding).toBe("utf8");
  });

  it("reads a tar entry", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    const result = await tool.run(
      { path: "sample.tar", entry: "nested/world.txt" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toContain("Nested payload.");
  });

  it("reads a tar.gz entry", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    const result = await tool.run(
      { path: "sample.tar.gz", entry: "hello.txt" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toContain("Hello from the archive.");
  });

  it("reads a gz payload via its synthetic entry name", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    const result = await tool.run(
      { path: "sample.txt.gz", entry: "sample.txt" },
      makeCtx(FIXTURES),
    );
    expect(result.summary).toContain("single file gzip payload");
  });

  it("forces base64 when as='base64'", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    const result = await tool.run(
      { path: "sample.zip", entry: "hello.txt", as: "base64" },
      makeCtx(FIXTURES),
    );
    const details = (result.details ?? {}) as Record<string, unknown>;
    expect(details.encoding).toBe("base64");
    // The base64 summary is the full encoded body (small payload, so no
    // truncation happens). Decoding must give back the original text.
    expect(Buffer.from(result.summary, "base64").toString("utf8")).toBe(
      "Hello from the archive.\n",
    );
  });

  it("throws when the entry is missing", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    await expect(
      tool.run(
        { path: "sample.zip", entry: "missing.txt" },
        makeCtx(FIXTURES),
      ),
    ).rejects.toThrow(/entry not found/);
  });
});
