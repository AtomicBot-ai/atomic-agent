import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import { citeFor } from "./file-cite.js";
import type { FileIndexApi, FileIndexStatus, FileSearchHit, FileSearchOptions } from "./file-index-types.js";
import { FolderRejectedError } from "./file-index-types.js";
import { buildFilesSearchTool, FILES_SEARCH_TOOL, renderHits } from "./files-search-tool.js";

function ctx(workingDir = "/w"): ToolContext {
  return { workingDir, sessionId: "s", stepIndex: 0, signal: new AbortController().signal };
}

const DONE: FileIndexStatus = { running: false, found: 2, indexed: 2, failed: 0, skipped: 0, updatedAt: "t" };
const PDF = "/Users/me/My Docs/report.pdf";
const HIT: FileSearchHit = {
  path: PDF,
  page: 12,
  snippet: "the «termination» clause needs 30 days",
  score: 1,
  cite: citeFor({ path: PDF, page: 12 }),
};

function fakeIndex(options: { hits?: FileSearchHit[]; folders?: number; status?: FileIndexStatus; reject?: Error } = {}) {
  const calls: FileSearchOptions[] = [];
  const index: Pick<FileIndexApi, "search" | "listFolders" | "status"> = {
    async search(request) {
      calls.push(request);
      if (options.reject) throw options.reject;
      return options.hits ?? [HIT];
    },
    listFolders: () =>
      Array.from({ length: options.folders ?? 1 }, (_, i) => ({ path: `/f${i}`, name: `f${i}`, fileCount: 1, indexedCount: 1, addedAt: "t" })),
    status: () => options.status ?? DONE,
  };
  return { index, calls };
}

describe("files.search", () => {
  it("is a read-only tool whose description tells the model to paste `cite` as is", () => {
    const tool = buildFilesSearchTool(fakeIndex());
    expect(tool.name).toBe(FILES_SEARCH_TOOL);
    expect(tool.readonly).toBe(true);
    expect(tool.untrustedOutput).toBe("indexed files");
    expect(tool.description).toContain("paste its `cite` exactly as given");
  });

  it("returns each hit with its cite, path, page and snippet", async () => {
    const { index, calls } = fakeIndex();
    const result = await buildFilesSearchTool({ index }).run({ query: "termination", topK: 5 }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("cite: [report.pdf, p. 12](file:///Users/me/My%20Docs/report.pdf#page=12)");
    expect(result.summary).toContain(`file: ${PDF} (page 12)`);
    expect(result.summary).toContain("the «termination» clause");
    expect(result.details.hits).toEqual([HIT]);
    expect(calls[0]).toMatchObject({ query: "termination", topK: 5 });
    expect(calls[0]!.folder).toBeUndefined();
  });

  it("resolves `folder` like other file tools (~ and relative to the working dir)", async () => {
    const { index, calls } = fakeIndex();
    const tool = buildFilesSearchTool({ index });
    await tool.run({ query: "x", folder: "~/Docs" }, ctx());
    await tool.run({ query: "x", folder: "reports" }, ctx("/w"));
    expect(calls.map((c) => c.folder)).toEqual([join(homedir(), "Docs"), "/w/reports"]);
  });

  it("says how to add a folder when My files is empty, without searching", async () => {
    const { index, calls } = fakeIndex({ folders: 0 });
    const result = await buildFilesSearchTool({ index }).run({ query: "x" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("No folders are in My files yet");
    expect(calls).toHaveLength(0);
  });

  it("notes when indexing is still running", async () => {
    const status = { ...DONE, running: true, found: 10, indexed: 4, skipped: 1 };
    const result = await buildFilesSearchTool(fakeIndex({ status })).run({ query: "x" }, ctx());
    expect(result.summary).toContain("indexing is still running: 5 of 10 files done");
  });

  it("answers validation errors for each bad argument", async () => {
    const tool = buildFilesSearchTool(fakeIndex());
    for (const [args, field] of [
      [{}, "query"],
      [{ query: "  " }, "query"],
      [{ query: "x".repeat(501) }, "query"],
      [{ query: "x", topK: 0 }, "topK"],
      [{ query: "x", topK: 21 }, "topK"],
      [{ query: "x", topK: 2.5 }, "topK"],
      [{ query: "x", folder: 7 }, "folder"],
    ] as const) {
      const result = await tool.run(args as Record<string, unknown>, ctx());
      expect(result.status, JSON.stringify(args)).toBe("error");
      expect(result.summary).toContain(`validation: ${field}:`);
    }
    const ok = await tool.run({ query: "x", topK: "3" }, ctx());
    expect(ok.status).toBe("ok");
  });

  it("turns a folder outside My files into a validation error", async () => {
    const reject = new FolderRejectedError("not_found", "/elsewhere is not in My files");
    const result = await buildFilesSearchTool(fakeIndex({ reject })).run({ query: "x", folder: "/elsewhere" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("validation: folder: /elsewhere is not in My files");
  });

  it("renderHits says when nothing matched", () => {
    expect(renderHits("zebra", [], "")).toBe('(nothing in My files matched "zebra")');
  });
});
