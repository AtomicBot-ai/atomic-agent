import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOsGitAddTool } from "./git-add.js";
import {
  makeApprovingGate,
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

function tool() {
  return buildOsGitAddTool({
    approvals: makeApprovingGate(),
    approvalRequired: false,
    trustConfigPaths: [],
  });
}

async function porcelain(repo: string): Promise<string[]> {
  const out = (await runGitRaw(repo, ["status", "--porcelain"])).stdout;
  return out.split("\n").filter((line) => line.length > 0).sort();
}

describe("os.git.add", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await writeRepoFile(repo, "a.txt", "a\n");
    await writeRepoFile(repo, "b.txt", "b\n");
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("stages only the named paths", async () => {
    const result = await tool().run({ paths: ["a.txt"] }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await porcelain(repo)).toEqual(["?? b.txt", "A  a.txt"]);
    expect(result.details.action).toBe("add");
    expect(result.details.staged).toEqual(["a.txt"]);
    expect(result.details.counts).toEqual({ staged: 1, unstaged: 0, untracked: 1 });
    expect(result.summary).toContain("1 staged, 0 modified (unstaged), 1 untracked");
  });

  it("stages everything with all: true", async () => {
    const result = await tool().run({ all: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await porcelain(repo)).toEqual(["A  a.txt", "A  b.txt"]);
    expect(result.details.counts).toEqual({ staged: 2, unstaged: 0, untracked: 0 });
    expect(result.details.all).toBe(true);
  });

  it("unstages a path on a repository with commits", async () => {
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "changed\n");
    await runGitRaw(repo, ["add", "a.txt"]);
    expect(await porcelain(repo)).toEqual(["M  a.txt"]);

    const result = await tool().run(
      { paths: ["a.txt"], unstage: true },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(result.details.action).toBe("unstage");
    expect(result.details.unborn).toBe(false);
    expect(await porcelain(repo)).toEqual([" M a.txt"]);
    expect(result.details.counts).toEqual({ staged: 0, unstaged: 1, untracked: 0 });
  });

  it("unstages everything on a repository with commits", async () => {
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "changed\n");
    await writeRepoFile(repo, "c.txt", "new\n");
    await runGitRaw(repo, ["add", "-A"]);
    expect(await porcelain(repo)).toEqual(["A  c.txt", "M  a.txt"]);

    const result = await tool().run({ all: true, unstage: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await porcelain(repo)).toEqual([" M a.txt", "?? c.txt"]);
  });

  it("unstages everything on an unborn repository", async () => {
    await runGitRaw(repo, ["add", "-A"]);
    expect(await porcelain(repo)).toEqual(["A  a.txt", "A  b.txt"]);

    const result = await tool().run({ all: true, unstage: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.unborn).toBe(true);
    expect(await porcelain(repo)).toEqual(["?? a.txt", "?? b.txt"]);
    expect(result.details.counts).toEqual({ staged: 0, unstaged: 0, untracked: 2 });
  });

  it("unstages a path on an unborn repository", async () => {
    await runGitRaw(repo, ["add", "-A"]);
    const result = await tool().run(
      { paths: ["a.txt"], unstage: true },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(await porcelain(repo)).toEqual(["?? a.txt", "A  b.txt"]);
    expect(result.details.staged).toEqual(["b.txt"]);
  });

  it("returns a structured error when neither all nor paths is given", async () => {
    const result = await tool().run({}, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.summary).toContain("all: true");
    expect(result.summary).toContain("paths");
    expect(await porcelain(repo)).toEqual(["?? a.txt", "?? b.txt"]);
  });

  it("rejects all and paths together, and malformed paths", async () => {
    const both = await tool().run({ all: true, paths: ["a.txt"] }, makeCtx(repo));
    expect(both.status).toBe("error");
    expect(both.summary).toContain("not both");
    const malformed = await tool().run({ paths: ["a.txt", ""] }, makeCtx(repo));
    expect(malformed.status).toBe("error");
    expect(malformed.summary).toContain("non-empty strings");
    expect(await porcelain(repo)).toEqual(["?? a.txt", "?? b.txt"]);
  });

  it("surfaces git's own error for a path that matches nothing", async () => {
    const result = await tool().run({ paths: ["nope.txt"] }, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/did not match any files/);
  });

  it("returns a structured error outside a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "atomic-git-plain-"));
    try {
      const result = await tool().run({ all: true }, makeCtx(plain));
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/not a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("accepts an explicit repo argument", async () => {
    const result = await tool().run({ repo, all: true }, makeCtx(tmpdir()));
    expect(result.status).toBe("ok");
    expect(await porcelain(repo)).toEqual(["A  a.txt", "A  b.txt"]);
  });
});
