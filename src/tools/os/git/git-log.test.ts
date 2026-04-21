import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitLogTool } from "./git-log.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

describe("os.git.log", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("returns structured commit entries", async () => {
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "first commit", "-m", "body line"]);
    await writeRepoFile(repo, "b.txt", "two\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "second commit"]);

    const result = await osGitLogTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(2);
    const entries = result.details.entries as { subject: string; body?: string }[];
    expect(entries[0].subject).toBe("second commit");
    expect(entries[1].subject).toBe("first commit");
    expect(entries[1].body).toBe("body line");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await writeRepoFile(repo, `f${i}.txt`, String(i));
      await runGitRaw(repo, ["add", "."]);
      await runGitRaw(repo, ["commit", "-m", `commit ${i}`]);
    }
    const result = await osGitLogTool.run({ limit: 2 }, makeCtx(repo));
    expect(result.details.count).toBe(2);
  });

  it("filters by path", async () => {
    await writeRepoFile(repo, "a.txt", "a");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "touched a"]);
    await writeRepoFile(repo, "b.txt", "b");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "touched b"]);

    const result = await osGitLogTool.run({ path: "a.txt" }, makeCtx(repo));
    expect(result.details.count).toBe(1);
    expect(
      (result.details.entries as { subject: string }[])[0]!.subject,
    ).toBe("touched a");
  });
});
