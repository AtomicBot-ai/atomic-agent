import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { osGitDiffTool } from "./git-diff.js";
import { GUEST_DIFF_FLAGS } from "./git-guest-pathspec.js";
import { osGitShowTool } from "./git-show.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

// Review round 2: with `diff.submodule=diff` in the repo config, git
// prints a changed submodule's own patch. The guest pathspec excludes
// do not reach inside it, so a `.env` committed in the submodule went
// out. A guest's diff and show pin `--submodule=short`.
describe.skipIf(process.platform === "win32")("guest diff of a changed submodule", () => {
  let outer: string;
  let inner: string;
  const guestCtx = (dir: string) => ({ ...makeCtx(dir), guest: true });
  const ID = ["-c", "user.name=T", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false"];

  beforeEach(async () => {
    inner = await makeGitRepo("atomic-git-sub-inner-");
    await writeRepoFile(inner, "readme.txt", "inner\n");
    await runGitRaw(inner, ["add", "."]);
    await runGitRaw(inner, ["commit", "-q", "-m", "inner seed"]);

    outer = await makeGitRepo("atomic-git-sub-outer-");
    await writeRepoFile(outer, "a.txt", "outer\n");
    await runGitRaw(outer, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "mod"]);
    await runGitRaw(outer, ["add", "."]);
    await runGitRaw(outer, ["commit", "-q", "-m", "add submodule"]);

    const mod = join(outer, "mod");
    await writeRepoFile(mod, ".env", "TOKEN=submodule-env-secret\n");
    await runGitRaw(mod, ["add", "."]);
    await runGitRaw(mod, [...ID, "commit", "-q", "-m", "secret in submodule"]);
    await runGitRaw(outer, ["config", "diff.submodule", "diff"]);
  });

  afterEach(async () => {
    await rm(outer, { recursive: true, force: true });
    await rm(inner, { recursive: true, force: true });
  });

  it("the plain diff with diff.submodule=diff really prints the submodule .env", async () => {
    const raw = await runGitRaw(outer, ["diff"]);
    expect(raw.stdout).toContain("submodule-env-secret");
  });

  it("a guest's working-tree diff shows only the submodule commit line", async () => {
    const res = await osGitDiffTool.run({}, guestCtx(outer));
    expect(res.output).not.toContain("submodule-env-secret");
    expect(res.output).toContain("Subproject commit");
  });

  it("a guest's show of the commit that moves the submodule hides its .env", async () => {
    await runGitRaw(outer, ["add", "mod"]);
    await runGitRaw(outer, ["commit", "-q", "-m", "bump submodule"]);
    const res = await osGitShowTool.run({ revision: "HEAD", patch: true }, guestCtx(outer));
    expect(JSON.stringify(res)).not.toContain("submodule-env-secret");
  });

  it("pins --submodule=short", () => {
    expect(GUEST_DIFF_FLAGS).toContain("--submodule=short");
  });
});
