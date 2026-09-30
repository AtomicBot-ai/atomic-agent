import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { osGitLogTool } from "./git-log.js";
import {
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

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
    const entries = result.details.entries as {
      subject: string;
      body?: string;
    }[];
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
    expect((result.details.entries as { subject: string }[])[0]!.subject).toBe(
      "touched a",
    );
  });

  // `formatHumanLog` spends two lines on each commit, so the
  // compressor's default 12-line tail keeps only the six OLDEST
  // commits, and the 385-char head-slice then leaves two or three.
  // `listingResultCaps` budgets `limit` commits instead.
  it("keeps the newest commits in the summary, not the oldest", async () => {
    // Ten commits is twenty rendered lines — past the compressor's
    // twelve-line tail, which is the cut this test is about.
    for (let i = 0; i < 10; i++) {
      await runGitRaw(repo, [
        "commit",
        "--allow-empty",
        "-m",
        `commit number ${String(i).padStart(2, "0")} — a subject of average length`,
      ]);
    }

    const result = await osGitLogTool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.count).toBe(10);

    // Newest first, and the newest is the one the old tail dropped.
    expect(result.summary).toContain("commit number 09");
    expect(result.summary).toContain("commit number 00");
    // Two lines per commit, all ten of them, no omission marker.
    expect(result.summary.split("\n")).toHaveLength(20);
    expect(result.summary.length).toBeGreaterThan(900);
    expect(result.summary).not.toContain("[omitted");
    expect(result.summary).not.toContain("[truncated]");
  }, 120_000);
});
