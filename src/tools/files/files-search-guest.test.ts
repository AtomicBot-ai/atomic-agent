import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ToolContext } from "../tool-registry.js";
import { citeFor } from "./file-cite.js";
import type { FileIndexApi, FileSearchHit } from "./file-index-types.js";
import { buildFilesSearchTool } from "./files-search-tool.js";

/** ATO-2703: a guest's `files.search` never returns a passage of a `.env`, key or `secrets/` file. */
const hit = (path: string, snippet: string): FileSearchHit => ({ path, snippet, score: 1, cite: citeFor({ path }) });
const HITS = [
  hit("/w/config/.env", "API_KEY=sk-live-guest-must-not-see"),
  hit("/w/ops/secrets/notes.txt", "root password guest-must-not-see"),
  hit("/w/docs/setup.md", "Put the API key in config/.env"),
];
const index: Pick<FileIndexApi, "search" | "listFolders" | "status"> = {
  search: async () => HITS,
  listFolders: () => [{ path: "/w", name: "w", fileCount: 3, indexedCount: 3, addedAt: "t" }],
  status: () => ({ running: false, found: 3, indexed: 3, failed: 0, skipped: 0, updatedAt: "t" }),
};
const ctx = (guest: boolean): ToolContext => ({
  workingDir: "/w",
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});

describe("files.search for a guest (ATO-2703)", () => {
  it("drops hits from secret files and keeps the rest", async () => {
    const result = await buildFilesSearchTool({ index }).run({ query: "api key", folder: "/w" }, ctx(true));
    expect(result.summary).not.toContain("guest-must-not-see");
    expect(result.details.hits).toEqual([HITS[2]]);
    expect(result.details.count).toBe(1);
  });

  it("returns every hit to the owner", async () => {
    const result = await buildFilesSearchTool({ index }).run({ query: "api key", folder: "/w" }, ctx(false));
    expect(result.details.hits).toEqual(HITS);
  });

  it("drops a real-path hit under secrets/ when the working directory is a symlink (review F1963.3)", async () => {
    const real = realpathSync(mkdtempSync(join(tmpdir(), "files-search-real-")));
    const linkDir = mkdtempSync(join(tmpdir(), "files-search-link-"));
    try {
      mkdirSync(join(real, "secrets"));
      const alias = join(linkDir, "work");
      symlinkSync(real, alias);
      // The index stores folders and hits by real path.
      const realHits = [hit(join(real, "secrets", "notes.md"), "root password guest-must-not-see"), hit(join(real, "docs", "a.md"), "fine")];
      const realIndex: Pick<FileIndexApi, "search" | "listFolders" | "status"> = {
        ...index,
        search: async () => realHits,
        listFolders: () => [{ path: real, name: "work", fileCount: 2, indexedCount: 2, addedAt: "t" }],
      };
      const result = await buildFilesSearchTool({ index: realIndex }).run(
        { query: "password", folder: real },
        { ...ctx(true), workingDir: alias },
      );
      expect(result.summary).not.toContain("guest-must-not-see");
      expect(result.details.hits).toEqual([realHits[1]]);
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(linkDir, { recursive: true, force: true });
    }
  });
});
