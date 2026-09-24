import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { buildOsGitCheckoutTool, requireBranchName } from "./git-checkout.js";
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

function denyAll(): ApprovalGate {
  const gate = new ApprovalGate({
    emit: (req) => gate.reject(req.approvalId, "denied"),
  });
  return gate;
}

describe("os.git.checkout", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeGitRepo();
    await writeRepoFile(repo, "a.txt", "one\n");
    await runGitRaw(repo, ["add", "."]);
    await runGitRaw(repo, ["commit", "-m", "init"]);
  }, 30_000);
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  }, 30_000);

  it("creates and switches to a branch", async () => {
    const tool = buildOsGitCheckoutTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    const result = await tool.run(
      { branch: "feat/x", create: true },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(result.details.created).toBe(true);
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("feat/x");
  });

  it("switches to an existing branch", async () => {
    await runGitRaw(repo, ["branch", "other"]);
    const tool = buildOsGitCheckoutTool({
      approvals: approveAll(),
      approvalRequired: true,
    });
    await tool.run({ branch: "other" }, makeCtx(repo));
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("other");
  });

  it("does nothing when approval is denied", async () => {
    const tool = buildOsGitCheckoutTool({
      approvals: denyAll(),
      approvalRequired: true,
    });
    await expect(
      tool.run({ branch: "feat/x", create: true }, makeCtx(repo)),
    ).rejects.toThrow(/approval denied/);
    const head = await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
    expect(head.stdout.trim()).toBe("main");
    const branches = await runGitRaw(repo, ["branch", "--list", "feat/x"]);
    expect(branches.stdout.trim()).toBe("");
  });

  it("refuses a flag-shaped startPoint that would reset the working tree", async () => {
    // `git checkout -b x --force` permutes the option and discards
    // local changes; the tool promises never to.
    await writeRepoFile(repo, "a.txt", "dirty\n");
    const tool = buildOsGitCheckoutTool({
      approvals: approveAll(),
      approvalRequired: false,
    });
    await expect(
      tool.run(
        { branch: "x", create: true, startPoint: "--force" },
        makeCtx(repo),
      ),
    ).rejects.toThrow(/`startPoint` must not start with '-'/);
    const status = await runGitRaw(repo, ["status", "--porcelain"]);
    expect(status.stdout).toContain(" M a.txt");
  });

  it("asks for approval with the git command as the preview", async () => {
    let preview: string | undefined;
    const gate = new ApprovalGate({
      emit: (req) => {
        preview = req.preview;
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    const tool = buildOsGitCheckoutTool({
      approvals: gate,
      approvalRequired: true,
    });
    await tool.run(
      { branch: "feat/y", create: true, startPoint: "main" },
      makeCtx(repo),
    );
    expect(preview).toBe("git checkout -b feat/y main");
  });

  it("refuses a missing branch with git's own reason", async () => {
    const tool = buildOsGitCheckoutTool({
      approvals: approveAll(),
      approvalRequired: false,
    });
    // A result, not a rejection: a failed write verb is something the
    // model recovers from, and `git-error-result.ts` says so. Throwing
    // also put the message on the generic 400-char path, which is what
    // lost the remedy line on a real refusal.
    const result = await tool.run({ branch: "nope" }, makeCtx(repo));
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/did not match any file|pathspec/);
  });

  it("rejects startPoint without create", async () => {
    const tool = buildOsGitCheckoutTool({
      approvals: approveAll(),
      approvalRequired: false,
    });
    await expect(
      tool.run({ branch: "main", startPoint: "HEAD~1" }, makeCtx(repo)),
    ).rejects.toThrow(/only makes sense with/);
  });
});

describe("requireBranchName", () => {
  it("rejects flag-shaped and blank names", () => {
    expect(() => requireBranchName("--orphan", "t")).toThrow(
      /must not start with '-'/,
    );
    expect(() => requireBranchName("", "t")).toThrow(/non-empty/);
    expect(() => requireBranchName("a b", "t")).toThrow(/whitespace/);
    expect(requireBranchName(" feat/x ", "t")).toBe("feat/x");
  });
});

describe("a refused checkout keeps git's remedy (field regression)", () => {
  it("comes back as a sized error result, not a thrown step error", async () => {
    // Reproduced from a real run: five dirty files on deep paths make
    // git's refusal 466 characters, and its last line — the only line
    // the model can act on — sat past the compressor's bare 400-char
    // default. The trace recorded a 399-character summary cut mid-path.
    const repo = await makeGitRepo();
    const paths = [
      "src/tools/os/git/remote/handlers/network-sync-handler.ts",
      "src/tools/os/git/remote/handlers/credential-policy-handler.ts",
      "src/local-llm/backends/managed/daemon-lifecycle-supervisor.ts",
      "src/tui/components/local-models/download-progress-strip.tsx",
      "src/memory/links/generation/candidate-hydration-pipeline.ts",
    ];
    for (const p of paths) await writeRepoFile(repo, p, "base\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-m", "base"]);
    await runGitRaw(repo, ["checkout", "-b", "other-branch"]);
    for (const p of paths) await writeRepoFile(repo, p, `other ${p}\n`);
    await runGitRaw(repo, ["commit", "-am", "other"]);
    await runGitRaw(repo, ["checkout", "-"]);
    for (const p of paths) await writeRepoFile(repo, p, `dirty ${p}\n`);

    const tool = buildOsGitCheckoutTool({ approvals: approveAll() });
    const result = await tool.run(
      { repo, branch: "other-branch" },
      makeCtx(repo),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain(
      "Please commit your changes or stash them before you switch branches.",
    );
    // Every dirty path survives too — the list is what says WHICH files.
    for (const p of paths) expect(result.summary).toContain(p);
    await rm(repo, { recursive: true, force: true });
  }, 30_000);
});
