import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";

import { osGitDiffTool } from "./git-diff.js";
import { guestCommitRevision, GUEST_SECRET_EXCLUDES } from "./git-guest-pathspec.js";
import { osGitShowTool } from "./git-show.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

// ATO-2732: a guest's whole-commit show or plain diff must not print a
// `.env` (or a credential file) committed inside the working directory.
// The owner still sees everything.
describe.skipIf(process.platform === "win32")("guest git patches leave secrets out", () => {
  let repo: string;
  const guestCtx = (dir: string) => ({ ...makeCtx(dir), guest: true });

  beforeEach(async () => {
    repo = await makeGitRepo("atomic-git-guest-env-");
    await writeRepoFile(repo, "a.txt", "visible line\n");
    await writeRepoFile(repo, ".env", "TOKEN=root-env-secret\n");
    await writeRepoFile(repo, "config/.Env.production", "TOKEN=nested-env-secret\n");
    await writeRepoFile(repo, ".envrc", "export TOKEN=envrc-secret\n");
    await writeRepoFile(repo, ".ssh/id_rsa", "ssh-key-secret\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-q", "-m", "seed with secrets"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const SECRETS = ["root-env-secret", "nested-env-secret", "envrc-secret", "ssh-key-secret"];

  it("a guest's show of HEAD has the commit but no secret file", async () => {
    const result = await osGitShowTool.run({ revision: "HEAD" }, guestCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("visible line");
    for (const secret of SECRETS) expect(result.summary).not.toContain(secret);
    const paths = (result.details.files as { path: string }[]).map((f) => f.path);
    expect(paths).toEqual(["a.txt"]);
  });

  it("the owner's show of HEAD still has every file", async () => {
    const result = await osGitShowTool.run({ revision: "HEAD" }, makeCtx(repo));
    expect(result.status).toBe("ok");
    for (const secret of SECRETS) expect(result.summary).toContain(secret);
  });

  it("a guest's working-tree and range diffs leave the .env out", async () => {
    await writeRepoFile(repo, "a.txt", "visible change\n");
    await writeRepoFile(repo, ".env", "TOKEN=rotated-env-secret\n");
    const working = await osGitDiffTool.run({}, guestCtx(repo));
    expect(working.summary).toContain("visible change");
    expect(working.summary).not.toContain("env-secret");

    await runGitRaw(repo, ["commit", "-q", "-am", "rotate"]);
    const range = await osGitDiffTool.run({ revisionRange: "HEAD~1..HEAD" }, guestCtx(repo));
    expect(range.summary).toContain("visible change");
    expect(range.summary).not.toContain("env-secret");

    const owner = await osGitDiffTool.run({ revisionRange: "HEAD~1..HEAD" }, makeCtx(repo));
    expect(owner.summary).toContain("rotated-env-secret");
  });

  it("a guest cannot show the .env blob by its object id", async () => {
    const blob = (await runGitRaw(repo, ["rev-parse", "HEAD:.env"])).stdout.trim();
    // Peeled, git itself refuses the blob ("exited with"); unpeeled, git
    // would print the blob and only the metadata parser would fail.
    await expect(osGitShowTool.run({ revision: blob }, guestCtx(repo))).rejects.toThrow(/exited with/);
    const owner = await osGitShowTool.run({ revision: "HEAD" }, makeCtx(repo));
    expect(owner.status).toBe("ok");
  });

  it("peels each side of a range to a commit", () => {
    expect(guestCommitRevision("HEAD")).toBe("HEAD^{commit}");
    expect(guestCommitRevision("main..HEAD")).toBe("main^{commit}..HEAD^{commit}");
    expect(guestCommitRevision("a...b")).toBe("a^{commit}...b^{commit}");
    expect(guestCommitRevision("main..")).toBe("main^{commit}..");
    expect(guestCommitRevision("^main")).toBe("^main^{commit}");
  });

  it("excludes are case-insensitive globs that reach every folder", () => {
    expect(GUEST_SECRET_EXCLUDES).toContain(":(exclude,glob,icase)**/.env");
    expect(GUEST_SECRET_EXCLUDES).toContain(":(exclude,glob,icase)**/.ssh/**");
  });
});
