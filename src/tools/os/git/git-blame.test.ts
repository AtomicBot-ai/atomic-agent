import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitBlameTool } from "./git-blame.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

describe("os.git.blame", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("annotates each line with author/commit info", async () => {
    await writeRepoFile(repo, "file.txt", "line A\nline B\nline C\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "seed"]);
    await writeRepoFile(repo, "file.txt", "line A\nline B UPDATED\nline C\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "update line B"]);

    const result = await osGitBlameTool.run(
      { path: "file.txt" },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(result.details.lineCount).toBe(3);
    const entries = result.details.entries as {
      line: number;
      content: string;
      author: string;
    }[];
    expect(entries[0]!.author).toBe("Magos Test");
    expect(entries[1]!.content).toBe("line B UPDATED");
  });

  it("respects startLine/endLine range", async () => {
    await writeRepoFile(repo, "f.txt", "1\n2\n3\n4\n5\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "seed"]);

    const result = await osGitBlameTool.run(
      { path: "f.txt", startLine: 2, endLine: 4 },
      makeCtx(repo),
    );
    expect(result.details.lineCount).toBe(3);
    const entries = result.details.entries as { line: number }[];
    expect(entries[0]!.line).toBe(2);
    expect(entries.at(-1)!.line).toBe(4);
  });

  it("rejects endLine < startLine", async () => {
    await writeRepoFile(repo, "f.txt", "1\n2\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "seed"]);
    await expect(
      osGitBlameTool.run(
        { path: "f.txt", startLine: 5, endLine: 2 },
        makeCtx(repo),
      ),
    ).rejects.toThrow(/endLine must be >= startLine/);
  });
});
