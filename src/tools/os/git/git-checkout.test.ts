import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildOsGitCheckoutTool } from "./git-checkout.js";
import {
  makeApprovingGate,
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

function tool() {
  return buildOsGitCheckoutTool({
    approvals: makeApprovingGate(),
    approvalRequired: false,
    trustConfigPaths: [],
  });
}

async function currentBranch(repo: string): Promise<string> {
  return (await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim();
}

async function headHash(repo: string): Promise<string> {
  return (await runGitRaw(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

describe("os.git.checkout", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await writeRepoFile(repo, "f.txt", "one\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "first"]);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("switches to an existing branch", async () => {
    await runGitRaw(repo, ["branch", "feature"]);
    const result = await tool().run({ branch: "feature" }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await currentBranch(repo)).toBe("feature");
    expect(result.details.branch).toBe("feature");
    expect(result.details.previousBranch).toBe("main");
    expect(result.details.created).toBe(false);
    expect(result.details.hash).toBe(await headHash(repo));
    expect(result.summary).toContain("switched to branch 'feature'");
  });

  it("creates a branch from HEAD with create: true", async () => {
    const result = await tool().run({ branch: "topic", create: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await currentBranch(repo)).toBe("topic");
    expect(result.details.created).toBe(true);
    expect(result.details.startPoint).toBeNull();
    const branches = (await runGitRaw(repo, ["branch", "--list", "topic"])).stdout;
    expect(branches).toContain("topic");
    expect(result.summary).toContain("created and switched to branch 'topic'");
  });

  it("creates a branch from an explicit start point", async () => {
    const first = await headHash(repo);
    await writeRepoFile(repo, "f.txt", "two\n");
    await runGitRaw(repo, ["commit", "-q", "-a", "-m", "second"]);
    expect(await headHash(repo)).not.toBe(first);

    const result = await tool().run(
      { branch: "from-first", create: true, startPoint: "HEAD~1" },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(await currentBranch(repo)).toBe("from-first");
    expect(await headHash(repo)).toBe(first);
    expect(result.details.hash).toBe(first);
    expect(result.details.startPoint).toBe("HEAD~1");
    expect(await readFile(join(repo, "f.txt"), "utf8")).toBe("one\n");
  });

  it("returns git's error for an unknown branch and stays put", async () => {
    const result = await tool().run({ branch: "nope" }, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/invalid reference: nope/);
    expect(result.details.branch).toBe("nope");
    expect(await currentBranch(repo)).toBe("main");
  });

  it("lets git refuse a switch that would overwrite local changes", async () => {
    await runGitRaw(repo, ["switch", "-q", "-c", "other"]);
    await writeRepoFile(repo, "f.txt", "other\n");
    await runGitRaw(repo, ["commit", "-q", "-a", "-m", "other f"]);
    await runGitRaw(repo, ["switch", "-q", "main"]);
    await writeRepoFile(repo, "f.txt", "dirty\n");

    const result = await tool().run({ branch: "other" }, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/would be overwritten/);
    expect(await currentBranch(repo)).toBe("main");
    expect(await readFile(join(repo, "f.txt"), "utf8")).toBe("dirty\n");
  });

  it("rejects a missing branch, option-like names, and startPoint without create", async () => {
    const missing = await tool().run({}, makeCtx(repo));
    expect(missing.status).toBe("error");
    expect(missing.summary).toContain("`branch` is required");

    const optionLike = await tool().run({ branch: "--orphan" }, makeCtx(repo));
    expect(optionLike.status).toBe("error");
    expect(optionLike.summary).toContain('may not start with "-"');

    const stray = await tool().run(
      { branch: "x", startPoint: "HEAD~1" },
      makeCtx(repo),
    );
    expect(stray.status).toBe("error");
    expect(stray.summary).toContain("`startPoint` only applies with `create: true`");

    expect(await currentBranch(repo)).toBe("main");
  });
});
