import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitPushTool, buildPushInvocation } from "./git-push.js";
import {
  makeCtx,
  makeGitRepo,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

function approveAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
  });
  return gate;
}

const TOKEN = `ghp_${"A".repeat(36)}`;

describe("os.git.push", () => {
  let repo: string;
  let bare: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    bare = await mkdtemp(join(tmpdir(), "atomic-git-bare-"));
    await runGitRaw(bare, ["init", "--bare", "-q", "--initial-branch=main"]);
    await runGitRaw(repo, ["remote", "add", "origin", bare]);
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
  }, 30_000);
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  });

  it("pushes the current branch with -u and reports the upstream", async () => {
    const tool = buildOsGitPushTool({
      approvals: approveAll(),
      approvalRequired: true,
      resolveToken: () => TOKEN,
    });
    const result = await tool.run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.branch).toBe("main");
    expect(result.details.remote).toBe("origin");
    // A local remote is not github.com: the token must not be attached.
    expect(result.details.authenticated).toBe(false);
    const remoteHead = await runGitRaw(bare, ["rev-parse", "main"]);
    const localHead = await runGitRaw(repo, ["rev-parse", "main"]);
    expect(remoteHead.stdout.trim()).toBe(localHead.stdout.trim());
    const upstream = await runGitRaw(repo, [
      "rev-parse",
      "--abbrev-ref",
      "main@{upstream}",
    ]);
    expect(upstream.stdout.trim()).toBe("origin/main");
  });

  it("pushes a named branch without -u when asked", async () => {
    await runGitRaw(repo, ["branch", "feat/x"]);
    const tool = buildOsGitPushTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { branch: "feat/x", setUpstream: false },
      makeCtx(repo),
    );
    expect(result.details.setUpstream).toBe(false);
    const remoteBranches = await runGitRaw(bare, ["branch", "--list"]);
    expect(remoteBranches.stdout).toContain("feat/x");
    const upstream = await runGitRaw(repo, [
      "config",
      "--get",
      "branch.feat/x.remote",
    ]).catch(() => ({ stdout: "" }));
    expect(upstream.stdout.trim()).toBe("");
  });

  it("previews the command and the remote before asking", async () => {
    let preview: string | undefined;
    const gate = new ApprovalGate({
      emit: (req) => {
        preview = req.preview;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsGitPushTool({
      approvals: gate,
      approvalRequired: true,
    });
    await tool.run({}, makeCtx(repo));
    expect(preview).toContain("git push -u origin main:main");
    expect(preview).toContain(`remote: ${bare}`);
    expect(preview).not.toContain("auth:");
  });

  it("does not push when approval is denied", async () => {
    const gate = new ApprovalGate({
      emit: (req) => gate.reject(req.approvalId, "denied"),
    });
    const tool = buildOsGitPushTool({
      approvals: gate,
      approvalRequired: true,
    });
    await expect(tool.run({}, makeCtx(repo))).rejects.toThrow(
      /approval denied/,
    );
    const remoteBranches = await runGitRaw(bare, ["branch", "--list"]);
    expect(remoteBranches.stdout.trim()).toBe("");
  });

  it("refuses an unknown remote before asking for approval", async () => {
    let asked = false;
    const gate = new ApprovalGate({
      emit: (req) => {
        asked = true;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsGitPushTool({
      approvals: gate,
      approvalRequired: true,
    });
    await expect(
      tool.run({ remote: "upstream" }, makeCtx(repo)),
    ).rejects.toThrow(/remote "upstream" is not configured/);
    expect(asked).toBe(false);
  });

  it("refuses to push a detached HEAD without an explicit branch", async () => {
    await runGitRaw(repo, ["checkout", "-q", "--detach"]);
    const tool = buildOsGitPushTool({
      approvals: approveAll(),
      approvalRequired: false,
    });
    await expect(tool.run({}, makeCtx(repo))).rejects.toThrow(/detached/);
  });

  it("surfaces a rejected push as the tool's error", async () => {
    // Make the remote ahead so a non-force push is rejected.
    const other = await makeGitRepo();
    try {
      await runGitRaw(other, ["remote", "add", "origin", bare]);
      await writeRepoFile(other, "z.txt", "z\n");
      await runGitRaw(other, ["add", "."]);
      await runGitRaw(other, ["commit", "-m", "remote-ahead"]);
      await runGitRaw(other, ["push", "-q", "origin", "main"]);
      const tool = buildOsGitPushTool({
        approvals: approveAll(),
        approvalRequired: false,
      });
      await expect(tool.run({}, makeCtx(repo))).rejects.toThrow(
        /os\.git\.push: git push exited/,
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("buildPushInvocation", () => {
  it("attaches the token through the env for an https github.com remote, never argv", () => {
    const inv = buildPushInvocation({
      remote: "origin",
      branch: "feat/x",
      setUpstream: true,
      remoteUrl: "https://github.com/acme/widgets.git",
      token: TOKEN,
    });
    expect(inv.authenticated).toBe(true);
    expect(inv.args).toEqual(["push", "-u", "origin", "feat/x:feat/x"]);
    expect(inv.args.join(" ")).not.toContain(TOKEN);
    expect(inv.env.GIT_CONFIG_KEY_0).toBe(
      "http.https://github.com/.extraheader",
    );
    expect(inv.env.GIT_CONFIG_VALUE_0).toContain("AUTHORIZATION: basic ");
  });

  it("leaves an SSH or non-GitHub remote to the operator's own git auth", () => {
    for (const remoteUrl of [
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets.git",
      "https://gitlab.com/acme/widgets.git",
      "/tmp/bare.git",
    ]) {
      const inv = buildPushInvocation({
        remote: "origin",
        branch: "main",
        setUpstream: false,
        remoteUrl,
        token: TOKEN,
      });
      expect(inv.authenticated).toBe(false);
      expect(inv.env).toEqual({});
      expect(inv.args).toEqual(["push", "origin", "main:main"]);
    }
  });

  it("does nothing special without a token", () => {
    const inv = buildPushInvocation({
      remote: "origin",
      branch: "main",
      setUpstream: true,
      remoteUrl: "https://github.com/acme/widgets.git",
      token: null,
    });
    expect(inv.authenticated).toBe(false);
    expect(inv.env).toEqual({});
  });
});
