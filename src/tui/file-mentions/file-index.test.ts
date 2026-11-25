import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMentionFileIndex, walkFiles, type FileIndexLimits } from "./file-index.js";

const limits: FileIndexLimits = { maxFiles: 100, budgetMs: 1000, freshMs: 1000 };

describe("walkFiles", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mention-walk-"));
    mkdirSync(join(root, "src", "deep"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "README.md"), "");
    writeFileSync(join(root, "src", "app.ts"), "");
    writeFileSync(join(root, "src", "deep", "x.ts"), "");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
    writeFileSync(join(root, ".git", "HEAD"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("lists files as relative paths and skips dependency folders", async () => {
    const files = await walkFiles(root, limits);
    expect(files.sort()).toEqual(["README.md", "src/app.ts", "src/deep/x.ts"]);
  });

  it("stops at the file cap", async () => {
    const files = await walkFiles(root, { ...limits, maxFiles: 2 });
    expect(files).toHaveLength(2);
  });

  it("stops when the time budget is spent", async () => {
    let t = 0;
    // Each clock read advances past the deadline after the first folder.
    const files = await walkFiles(root, { ...limits, budgetMs: 2 }, () => (t += 1));
    expect(files).toEqual(["README.md"]);
  });
});

describe("createMentionFileIndex", () => {
  it("lists once per folder and reuses the list while it is fresh", async () => {
    const listFiles = vi.fn(async () => ["a.ts", "with space.ts", "b.ts"]);
    let now = 0;
    const index = createMentionFileIndex({ limits, listFiles, now: () => now });
    expect(await index.list("/p")).toEqual(["a.ts", "b.ts"]);
    now = 500;
    expect(await index.list("/p")).toEqual(["a.ts", "b.ts"]);
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it("answers from the cache and refreshes behind it once stale", async () => {
    const lists = [["a.ts"], ["a.ts", "new.ts"]];
    const listFiles = vi.fn(async () => lists.shift() ?? []);
    let now = 0;
    const index = createMentionFileIndex({ limits, listFiles, now: () => now });
    await index.list("/p");
    now = 5000;
    expect(await index.list("/p")).toEqual(["a.ts"]);
    await new Promise((done) => setTimeout(done, 0));
    expect(await index.list("/p")).toEqual(["a.ts", "new.ts"]);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("treats a failed listing as an empty one", async () => {
    const index = createMentionFileIndex({ limits, listFiles: async () => { throw new Error("boom"); } });
    expect(await index.list("/p")).toEqual([]);
  });
});
