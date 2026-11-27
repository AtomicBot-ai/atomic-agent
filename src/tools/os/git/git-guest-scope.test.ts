import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { guestGitEnv } from "./git-guest-scope.js";
import { runGit } from "./git-runner.js";
import { osGitShowTool } from "./git-show.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

// ATO-2221: a guest's git must not climb from the working directory into
// a bigger repository around it (the owner's home folder may be one) and
// print its tracked files.
describe.skipIf(process.platform === "win32")("guest git stays inside the working directory", () => {
  let outer: string;
  let work: string;

  beforeEach(async () => {
    outer = await makeGitRepo("atomic-git-guest-");
    await writeRepoFile(outer, ".env", "TOKEN=owner-secret\n");
    await writeRepoFile(outer, "notes.txt", "owner notes\n");
    await runGitRaw(outer, ["add", "."]);
    await runGitRaw(outer, ["commit", "-q", "-m", "owner files"]);
    work = join(outer, "project");
    await mkdir(work, { recursive: true });
  });

  afterEach(async () => {
    await rm(outer, { recursive: true, force: true });
  });

  const guestCtx = (dir: string) => ({ ...makeCtx(dir), guest: true });

  it("refuses a guest's git in a folder inside an outer repository", async () => {
    await expect(
      osGitShowTool.run({ revision: "HEAD" }, guestCtx(work)),
    ).rejects.toThrow(/refused for a guest/);
    await expect(
      runGit({
        workingDir: work,
        guest: true,
        args: ["cat-file", "-p", "HEAD:notes.txt"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/refused for a guest/);
  });

  it("still lets the owner use the outer repository", async () => {
    const result = await osGitShowTool.run({ revision: "HEAD" }, makeCtx(work));
    expect(result.status).toBe("ok");
    expect(result.details.commit.subject).toBe("owner files");
  });

  it("lets a guest use a repository rooted inside the working directory", async () => {
    await runGitRaw(work, ["init", "--initial-branch=main", "-q"]);
    await runGitRaw(work, ["config", "user.name", "Guest Test"]);
    await runGitRaw(work, ["config", "user.email", "guest@example.test"]);
    await runGitRaw(work, ["config", "commit.gpgsign", "false"]);
    await writeRepoFile(work, "a.txt", "inside\n");
    await runGitRaw(work, ["add", "."]);
    await runGitRaw(work, ["commit", "-q", "-m", "guest repo"]);
    const result = await osGitShowTool.run({ revision: "HEAD" }, guestCtx(work));
    expect(result.status).toBe("ok");
    expect(result.details.commit.subject).toBe("guest repo");
  });

  it("sets the ceiling to the working directory's parent and drops GIT_DIR", () => {
    const env = guestGitEnv({ GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer, PATH: "/bin" }, work);
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.PATH).toBe("/bin");
    // Canonical: on macOS the temp folder is a symlink into /private.
    expect(env.GIT_CEILING_DIRECTORIES?.endsWith(dirname(work))).toBe(true);
  });
});
