import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { refuseOptionLike } from "./git-arg-guard.js";
import { osGitBlameTool } from "./git-blame.js";
import { osGitBranchTool } from "./git-branch.js";
import { osGitDiffTool } from "./git-diff.js";
import { buildOsGitFetchTool } from "./git-fetch.js";
import { osGitLogTool } from "./git-log.js";
import { buildOsGitPullTool } from "./git-pull.js";
import { buildOsGitRemoteTool } from "./git-remote.js";
import type { GitRemoteToolOptions } from "./git-remote-policy.js";
import { osGitShowTool } from "./git-show.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

/**
 * ATO-2731: a revision, range or remote that starts with `-` reaches git
 * as an option. `--output=<file>` makes the read-only show/log/diff write
 * that file; these tests point it at a real path and check that nothing
 * is written, so they fail if any tool stops refusing.
 */
describe("os.git option-like arguments", () => {
  let repo: string;
  let scratch: string;
  let target: string;

  beforeEach(async () => {
    repo = await makeGitRepo("atomic-git-optinj-");
    scratch = await mkdtemp(join(tmpdir(), "atomic-git-optinj-out-"));
    target = join(scratch, "x");
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
    await writeRepoFile(repo, "a.txt", "two\n");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  function remoteOptions(): GitRemoteToolOptions {
    const gate = new ApprovalGate({
      emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
    });
    return { approvals: gate, approvalRequired: true, isRemoteSyncEnabled: () => true, env: {} };
  }

  it("os.git.show refuses revision --output=<file> and writes nothing", async () => {
    await expect(
      osGitShowTool.run({ revision: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with '-'/);
    expect(existsSync(target)).toBe(false);
  });

  it("os.git.log refuses revisionRange --output=<file> and writes nothing", async () => {
    await expect(
      osGitLogTool.run({ revisionRange: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with '-'/);
    expect(existsSync(target)).toBe(false);
  });

  it("os.git.diff refuses revisionRange --output=<file> and writes nothing", async () => {
    await expect(
      osGitDiffTool.run({ revisionRange: `--output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with '-'/);
    expect(existsSync(target)).toBe(false);
  });

  it("a leading space does not get an option past the check", async () => {
    await expect(
      osGitShowTool.run({ revision: `  --output=${target}` }, makeCtx(repo)),
    ).rejects.toThrow(/must not start with '-'/);
    expect(existsSync(target)).toBe(false);
  });

  it("os.git.blame and os.git.branch refuse option-like revisions", async () => {
    await expect(
      osGitBlameTool.run({ path: "a.txt", revision: "--since=1" }, makeCtx(repo)),
    ).rejects.toThrow(/`revision` must not start with '-'/);
    await expect(
      osGitBranchTool.run({ contains: "--merged" }, makeCtx(repo)),
    ).rejects.toThrow(/`contains` must not start with '-'/);
  });

  it("os.git.fetch refuses remote --upload-pack=<program> before asking", async () => {
    const marker = join(scratch, "ran");
    await expect(
      buildOsGitFetchTool(remoteOptions()).run(
        { remote: `--upload-pack=touch ${marker}` },
        makeCtx(repo),
      ),
    ).rejects.toThrow(/`remote` must not start with '-'/);
    expect(existsSync(marker)).toBe(false);
  });

  it("os.git.pull refuses an option-like remote or branch", async () => {
    const pull = buildOsGitPullTool(remoteOptions());
    await expect(pull.run({ remote: "--upload-pack=x" }, makeCtx(repo))).rejects.toThrow(
      /`remote` must not start with '-'/,
    );
    await expect(
      pull.run({ remote: "origin", branch: "--upload-pack=x" }, makeCtx(repo)),
    ).rejects.toThrow(/`branch` must not start with '-'/);
  });

  it("os.git.remote refuses an option-like name or url", async () => {
    const remote = buildOsGitRemoteTool(remoteOptions());
    const byName = await remote.run({ action: "add", name: "-f", url: scratch }, makeCtx(repo));
    expect(byName.status).toBe("error");
    await expect(
      remote.run({ action: "add", name: "up", url: "--mirror=fetch" }, makeCtx(repo)),
    ).rejects.toThrow(/`url` must not start with '-'/);
    const listed = await runGitRaw(repo, ["remote"]);
    expect(listed.stdout.trim()).toBe("");
  });

  it("ordinary revisions and ranges still work", async () => {
    const show = await osGitShowTool.run({ revision: "HEAD" }, makeCtx(repo));
    expect(show.status).toBe("ok");
    const log = await osGitLogTool.run({ revisionRange: "HEAD" }, makeCtx(repo));
    expect(log.status).toBe("ok");
    const diff = await osGitDiffTool.run({ revisionRange: "HEAD" }, makeCtx(repo));
    expect(diff.status).toBe("ok");
  });

  it("refuseOptionLike ignores an absent value and a caret range", () => {
    expect(() => refuseOptionLike("t", "f", undefined)).not.toThrow();
    expect(() => refuseOptionLike("t", "f", "^main")).not.toThrow();
    expect(() => refuseOptionLike("t", "f", "-n")).toThrow();
  });
});
