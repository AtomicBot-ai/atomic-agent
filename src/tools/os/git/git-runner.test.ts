import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { runGit } from "./git-runner.js";
import { makeGitRepo } from "./test-helpers.js";

describe("runGit", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("prepends --no-pager so git never blocks on a pager (cross-platform)", async () => {
    const result = await runGit({
      repo,
      workingDir: repo,
      args: ["rev-parse", "--is-inside-work-tree"],
      signal: new AbortController().signal,
    });
    expect(result.args[0]).toBe("--no-pager");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
});
