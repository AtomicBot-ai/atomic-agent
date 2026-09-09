import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCloneTool, repoNameFromUrl } from "./git-clone.js";
import { buildOsGitFetchTool } from "./git-fetch.js";
import { buildOsGitPullTool } from "./git-pull.js";
import { buildOsGitPushTool } from "./git-push.js";
import { buildOsGitRemoteTool } from "./git-remote.js";
import type { GitRemoteToolOptions } from "./git-remote-policy.js";
import { makeCtx, makeGitRepo, runGitRaw, writeRepoFile } from "./test-helpers.js";

/**
 * End-to-end over a local bare repository: no network, no token, but
 * every code path a GitHub remote would take — the policy check, the
 * git_remote approval, the credential injection (scoped to github.com,
 * so inert here) and git itself.
 */
describe("os.git remote sync tools", () => {
  let work: string;
  let bare: string;
  let scratch: string;
  let prompts: Array<{ tool: string; category: string; preview?: string }>;

  function options(remoteSync: boolean, decide: "approve" | "deny" = "approve"): GitRemoteToolOptions {
    const gate = new ApprovalGate({
      emit: (req) => {
        prompts.push({ tool: req.tool, category: req.category, preview: req.preview });
        if (decide === "approve") {
          gate.resolve({ approvalId: req.approvalId, approved: true });
        } else {
          gate.reject(req.approvalId, "no");
        }
      },
    });
    return {
      approvals: gate,
      approvalRequired: true,
      isRemoteSyncEnabled: () => remoteSync,
      env: {},
    };
  }

  beforeEach(async () => {
    prompts = [];
    scratch = await mkdtemp(join(tmpdir(), "atomic-git-sync-"));
    bare = join(scratch, "remote.git");
    await runGitRaw(scratch, ["init", "--bare", "-q", "--initial-branch=main", bare]);
    work = await makeGitRepo("atomic-git-work-");
    await writeRepoFile(work, "a.txt", "one\n");
    await runGitRaw(work, ["add", "."]);
    await runGitRaw(work, ["commit", "-q", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it("refuses every network verb before any prompt while remote sync is off", async () => {
    const off = options(false);
    const results = await Promise.all([
      buildOsGitRemoteTool(off).run({ action: "add", name: "origin", url: bare }, makeCtx(work)),
      buildOsGitFetchTool(off).run({}, makeCtx(work)),
      buildOsGitPullTool(off).run({}, makeCtx(work)),
      buildOsGitPushTool(off).run({}, makeCtx(work)),
      buildOsGitCloneTool(off).run({ url: bare, dest: join(scratch, "c") }, makeCtx(work)),
    ]);
    for (const r of results) {
      expect(r.status).toBe("error");
      expect(r.summary).toContain("remote sync is off");
      expect(r.details.refused).toBe(true);
    }
    expect(prompts).toEqual([]);
    // Nothing reached git: no remote was added, nothing was cloned.
    const remotes = await runGitRaw(work, ["remote"]);
    expect(remotes.stdout.trim()).toBe("");
    await expect(stat(join(scratch, "c"))).rejects.toThrow();
  });

  it("lists remotes read-only with the switch off", async () => {
    const out = await buildOsGitRemoteTool(options(false)).run({}, makeCtx(work));
    expect(out.status).toBe("ok");
    expect(out.summary).toContain("local-only");
    expect(prompts).toEqual([]);
  });

  it("add → push → fetch → pull round-trips through the bare remote with git_remote approvals", async () => {
    const on = options(true);
    const added = await buildOsGitRemoteTool(on).run(
      { action: "add", name: "origin", url: bare },
      makeCtx(work),
    );
    expect(added.status).toBe("ok");
    expect((added.details.remotes as Array<{ name: string }>).map((r) => r.name)).toEqual([
      "origin",
    ]);

    const pushed = await buildOsGitPushTool(on).run({}, makeCtx(work));
    expect(pushed.status).toBe("ok");
    expect(pushed.details).toMatchObject({ remote: "origin", branch: "main", setUpstream: true });
    const remoteHead = await runGitRaw(bare, ["rev-parse", "main"]);
    const localHead = await runGitRaw(work, ["rev-parse", "main"]);
    expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());

    // A second push has an upstream now and is a no-op.
    const again = await buildOsGitPushTool(on).run({}, makeCtx(work));
    expect(again.status).toBe("ok");
    expect(again.details.setUpstream).toBe(false);

    // Someone else advances the remote; fetch sees it, pull integrates it.
    const other = join(scratch, "other");
    await runGitRaw(scratch, ["clone", "-q", bare, other]);
    await runGitRaw(other, ["config", "user.name", "Other"]);
    await runGitRaw(other, ["config", "user.email", "other@test"]);
    await writeRepoFile(other, "b.txt", "two\n");
    await runGitRaw(other, ["add", "."]);
    await runGitRaw(other, ["commit", "-q", "-m", "second"]);
    await runGitRaw(other, ["push", "-q", "origin", "main"]);

    const fetched = await buildOsGitFetchTool(on).run({}, makeCtx(work));
    expect(fetched.status).toBe("ok");
    const behind = await runGitRaw(work, ["rev-list", "--count", "main..origin/main"]);
    expect(behind.stdout.trim()).toBe("1");

    const pulled = await buildOsGitPullTool(on).run({}, makeCtx(work));
    expect(pulled.status).toBe("ok");
    expect(await readFile(join(work, "b.txt"), "utf8")).toBe("two\n");

    expect(prompts.map((p) => [p.tool, p.category])).toEqual([
      ["os.git.remote", "git_remote"],
      ["os.git.push", "git_remote"],
      ["os.git.push", "git_remote"],
      ["os.git.fetch", "git_remote"],
      ["os.git.pull", "git_remote"],
    ]);
    expect(prompts[1]?.preview).toBe("git push --set-upstream origin main");
  });

  it("a denied approval stops the push and nothing reaches the remote", async () => {
    await runGitRaw(work, ["remote", "add", "origin", bare]);
    await expect(
      buildOsGitPushTool(options(true, "deny")).run({}, makeCtx(work)),
    ).rejects.toMatchObject({ name: "ApprovalDeniedError" });
    const refs = await runGitRaw(bare, ["show-ref"]).catch((e: Error) => ({ stdout: "", err: e }));
    expect(refs.stdout.trim()).toBe("");
  });

  it("clones into the working directory by repo name and refuses an existing destination", async () => {
    const on = options(true);
    const cloned = await buildOsGitCloneTool(on).run({ url: bare }, makeCtx(scratch));
    expect(cloned.status).toBe("ok");
    expect(cloned.details.dest).toBe(join(scratch, "remote"));
    expect((await stat(join(scratch, "remote", ".git"))).isDirectory()).toBe(true);
    expect(prompts[0]).toMatchObject({ tool: "os.git.clone", category: "git_remote" });

    const dup = await buildOsGitCloneTool(on).run({ url: bare }, makeCtx(scratch));
    expect(dup.status).toBe("error");
    expect(dup.summary).toContain("already exists");
  });

  it("refuses URLs that carry credentials, for add and for clone, before the switch is consulted", async () => {
    const off = options(false);
    const add = await buildOsGitRemoteTool(off).run(
      { action: "add", name: "origin", url: "https://me:ghp_secret@github.com/x/y.git" },
      makeCtx(work),
    );
    expect(add.status).toBe("error");
    expect(add.summary).toContain("embedded credentials");
    expect(add.summary).not.toContain("ghp_secret");
    const clone = await buildOsGitCloneTool(off).run(
      { url: "https://ghp_secret@github.com/x/y.git" },
      makeCtx(scratch),
    );
    expect(clone.status).toBe("error");
    expect(clone.summary).toContain("embedded credentials");
  });

  it("reports git's own failure as a structured error", async () => {
    const on = options(true);
    await runGitRaw(work, ["remote", "add", "origin", join(scratch, "does-not-exist.git")]);
    const out = await buildOsGitFetchTool(on).run({}, makeCtx(work));
    expect(out.status).toBe("error");
    expect(out.summary).toMatch(/exited with/);
    expect(out.details.exitCode).not.toBe(0);
  });

  it("push on a detached HEAD asks for a branch instead of guessing", async () => {
    await runGitRaw(work, ["remote", "add", "origin", bare]);
    await runGitRaw(work, ["checkout", "-q", "--detach"]);
    const out = await buildOsGitPushTool(options(true)).run({}, makeCtx(work));
    expect(out.status).toBe("error");
    expect(out.summary).toContain("detached");
    expect(prompts).toEqual([]);
  });

  it("derives a destination name from every common URL shape", () => {
    expect(repoNameFromUrl("https://github.com/x/y.git")).toBe("y");
    expect(repoNameFromUrl("git@github.com:x/y")).toBe("y");
    expect(repoNameFromUrl("/tmp/remote.git/")).toBe("remote");
  });
});
