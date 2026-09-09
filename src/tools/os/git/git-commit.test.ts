import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOsGitCommitTool } from "./git-commit.js";
import {
  makeApprovingGate,
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

function tool() {
  return buildOsGitCommitTool({
    approvals: makeApprovingGate(),
    approvalRequired: false,
    trustConfigPaths: [],
  });
}

async function headHash(repo: string): Promise<string> {
  return (await runGitRaw(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

async function commitCount(repo: string): Promise<number> {
  return Number((await runGitRaw(repo, ["rev-list", "--count", "HEAD"])).stdout.trim());
}

async function stageFirstFile(repo: string): Promise<void> {
  await writeRepoFile(repo, "a.txt", "one\ntwo\n");
  await runGitRaw(repo, ["add", "a.txt"]);
}

describe("os.git.commit", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("commits staged changes and reports hash, subject and stat", async () => {
    await stageFirstFile(repo);
    const result = await tool().run({ message: "feat: add a" }, makeCtx(repo));

    expect(result.status).toBe("ok");
    const hash = await headHash(repo);
    expect(result.details.hash).toBe(hash);
    expect(result.details.shortHash).toBe(hash.slice(0, 7));
    expect(result.details.subject).toBe("feat: add a");
    expect(result.details.branch).toBe("main");
    expect(result.details.filesChanged).toBe(1);
    expect(result.details.insertions).toBe(2);
    expect(result.details.deletions).toBe(0);
    const logged = (await runGitRaw(repo, ["log", "-1", "--format=%s"])).stdout.trim();
    expect(logged).toBe("feat: add a");
    expect(result.summary).toContain(`[main ${hash.slice(0, 7)}] feat: add a`);
    expect(result.summary).toContain("1 file(s) changed, 2 insertion(s)(+), 0 deletion(s)(-)");
  });

  it("counts insertions and deletions on a follow-up commit", async () => {
    await stageFirstFile(repo);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "one\nthree\nfour\n");
    await writeRepoFile(repo, "b.txt", "b\n");
    await runGitRaw(repo, ["add", "-A"]);

    const result = await tool().run({ message: "second" }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.filesChanged).toBe(2);
    expect(result.details.insertions).toBe(3);
    expect(result.details.deletions).toBe(1);
    expect(await commitCount(repo)).toBe(2);
  });

  it("commits tracked modifications with all: true without staging first", async () => {
    await stageFirstFile(repo);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "changed\n");
    await writeRepoFile(repo, "untracked.txt", "u\n");

    const result = await tool().run({ message: "fix: a", all: true }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await commitCount(repo)).toBe(2);
    const status = (await runGitRaw(repo, ["status", "--porcelain"])).stdout.trim();
    // -a commits tracked changes; the untracked file is left alone.
    expect(status).toBe("?? untracked.txt");
  });

  it("preserves a multi-line message as subject plus body", async () => {
    await stageFirstFile(repo);
    const result = await tool().run(
      { message: "feat: title\n\nbody line one\nbody line two" },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(result.details.subject).toBe("feat: title");
    const body = (await runGitRaw(repo, ["log", "-1", "--format=%b"])).stdout.trim();
    expect(body).toBe("body line one\nbody line two");
  });

  it("rejects a blank message without creating a commit", async () => {
    await stageFirstFile(repo);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "changed\n");
    await runGitRaw(repo, ["add", "a.txt"]);
    for (const message of ["", "   \n", undefined, 42]) {
      const result = await tool().run({ message }, makeCtx(repo));
      expect(result.status).toBe("error");
      expect(result.summary).toContain("`message` is required");
    }
    expect(await commitCount(repo)).toBe(1);
  });

  it("returns a structured error, not a throw, when there is nothing to commit", async () => {
    await stageFirstFile(repo);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    const result = await tool().run({ message: "empty" }, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("nothing_to_commit");
    expect(result.summary).toContain("nothing to commit");
    expect(result.summary).toContain("os.git.add");
    expect(await commitCount(repo)).toBe(1);
  });

  it("commits even when the repository config demands a signature", async () => {
    await stageFirstFile(repo);
    // Signing must fail loudly if it is ever attempted, so a green result
    // proves `-c commit.gpgsign=false` won, not that a key happened to exist.
    await runGitRaw(repo, ["config", "commit.gpgsign", "true"]);
    await runGitRaw(repo, ["config", "gpg.program", join(repo, "no-such-gpg")]);

    const result = await tool().run({ message: "unsigned" }, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(await commitCount(repo)).toBe(1);
    const raw = (await runGitRaw(repo, ["cat-file", "commit", "HEAD"])).stdout;
    expect(raw).not.toContain("gpgsig");
  });

  it("surfaces git's identity error verbatim with a hint pointing at os.git.init", async () => {
    await stageFirstFile(repo);
    await runGitRaw(repo, ["config", "--unset", "user.name"]);
    await runGitRaw(repo, ["config", "--unset", "user.email"]);
    // Hide the host's global identity and stop git from guessing one from
    // the hostname, so the failure is deterministic on every machine.
    await runGitRaw(repo, ["config", "user.useConfigOnly", "true"]);
    const scratch = await mkdtemp(join(tmpdir(), "atomic-git-noident-"));
    const emptyGlobal = join(scratch, "gitconfig");
    await writeFile(emptyGlobal, "", "utf8");
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
    try {
      const result = await tool().run({ message: "who" }, makeCtx(repo));
      expect(result.status).toBe("error");
      expect(result.details.reason).toBe("no_identity");
      const error = result.details.error as string;
      expect(error).toContain("Please tell me who you are");
      expect(error).toContain("os.git.init");
      expect(error).toContain("userName");
      expect(error).toContain("git config --global user.name");
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("returns a structured error outside a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "atomic-git-plain-"));
    try {
      const result = await tool().run({ message: "x" }, makeCtx(plain));
      expect(result.status).toBe("error");
      expect(result.summary).toMatch(/not a git repository/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
