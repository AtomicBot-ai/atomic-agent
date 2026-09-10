import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolDefinition } from "../../tool-registry.js";
import type { FsDangerousToolOptions } from "../fs-require-approval.js";
import { buildOsGitAddTool } from "./git-add.js";
import { buildOsGitCheckoutTool } from "./git-checkout.js";
import { buildOsGitCommitTool } from "./git-commit.js";
import { buildOsGitInitTool } from "./git-init.js";
import { formatGitCommandLine } from "./git-mutation-approval.js";
import {
  makeCtx,
  makeDenyingGate,
  makeGitRepo,
  makeRecordingGate,
  runGitRaw,
  writeRepoFile,
} from "./test-helpers.js";

type Builder = (options: FsDangerousToolOptions) => ToolDefinition;

/**
 * One row per write tool: how to build it, what to call it with, and how
 * to prove on disk that the mutation really happened (or did not).
 */
interface WriteCase {
  tool: string;
  build: Builder;
  args: Record<string, unknown>;
  prepare: (repo: string) => Promise<void>;
  mutated: (repo: string) => Promise<boolean>;
}

const CASES: WriteCase[] = [
  {
    tool: "os.git.add",
    build: buildOsGitAddTool,
    args: { all: true },
    prepare: async (repo) => {
      await writeRepoFile(repo, "new.txt", "n\n");
    },
    mutated: async (repo) =>
      (await runGitRaw(repo, ["status", "--porcelain"])).stdout.includes("A  new.txt"),
  },
  {
    tool: "os.git.commit",
    build: buildOsGitCommitTool,
    args: { message: "chore: gated" },
    prepare: async (repo) => {
      await writeRepoFile(repo, "new.txt", "n\n");
      await runGitRaw(repo, ["add", "new.txt"]);
    },
    mutated: async (repo) =>
      (await runGitRaw(repo, ["log", "--format=%s"])).stdout.includes("chore: gated"),
  },
  {
    tool: "os.git.checkout",
    build: buildOsGitCheckoutTool,
    args: { branch: "gated", create: true },
    prepare: async () => undefined,
    mutated: async (repo) =>
      (await runGitRaw(repo, ["symbolic-ref", "--short", "HEAD"])).stdout.trim() === "gated",
  },
];

function recording(prompts: ApprovalRequest[]): FsDangerousToolOptions {
  return {
    approvals: makeRecordingGate(prompts),
    approvalRequired: true,
    trustConfigPaths: [],
  };
}

describe("git write tools ride the fs approval ladder", () => {
  let repo: string;
  let canonicalRepo: string;

  beforeEach(async () => {
    repo = await makeGitRepo();
    canonicalRepo = await realpath(repo);
    await writeRepoFile(repo, "seed.txt", "s\n");
    await runGitRaw(repo, ["add", "-A"]);
    await runGitRaw(repo, ["commit", "-q", "-m", "seed"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  for (const c of CASES) {
    it(`${c.tool}: one fs_write_workspace request when the repo is the working dir`, async () => {
      await c.prepare(repo);
      const prompts: ApprovalRequest[] = [];
      const result = await c.build(recording(prompts)).run(c.args, makeCtx(repo));

      expect(result.status).toBe("ok");
      expect(await c.mutated(repo)).toBe(true);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt.tool).toBe(c.tool);
      expect(prompt.category).toBe("fs_write_workspace");
      expect(prompt.sessionId).toBe("test");
      expect(prompt.reason).toContain(canonicalRepo);
      expect(prompt.preview?.startsWith("git ")).toBe(true);
      expect(prompt.affectedResources).toEqual([canonicalRepo]);
      expect(prompt.redirectablePath).toBeUndefined();
    });

    it(`${c.tool}: no request at all when approvalRequired is false`, async () => {
      await c.prepare(repo);
      const prompts: ApprovalRequest[] = [];
      const result = await c
        .build({ ...recording(prompts), approvalRequired: false })
        .run(c.args, makeCtx(repo));
      expect(result.status).toBe("ok");
      expect(await c.mutated(repo)).toBe(true);
      expect(prompts).toHaveLength(0);
    });

    it(`${c.tool}: a denied approval throws ApprovalDeniedError and mutates nothing`, async () => {
      await c.prepare(repo);
      const tool = c.build({
        approvals: makeDenyingGate(),
        approvalRequired: true,
        trustConfigPaths: [],
      });
      await expect(tool.run(c.args, makeCtx(repo))).rejects.toMatchObject({
        name: "ApprovalDeniedError",
        tool: c.tool,
      });
      expect(await c.mutated(repo)).toBe(false);
    });
  }

  it("os.git.init categorises the directory that will receive .git", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atomic-git-ws-"));
    try {
      const prompts: ApprovalRequest[] = [];
      const target = join(workspace, "fresh");
      const result = await buildOsGitInitTool(recording(prompts)).run(
        { path: "fresh" },
        makeCtx(workspace),
      );
      expect(result.status).toBe("ok");
      expect((await stat(join(target, ".git"))).isDirectory()).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        tool: "os.git.init",
        category: "fs_write_workspace",
        reason: `git init in ${target}`,
        preview: `git init --initial-branch=main -- ${target}`,
        affectedResources: [target],
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("os.git.init: a denied approval leaves no repository behind", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "atomic-git-ws-"));
    try {
      const tool = buildOsGitInitTool({
        approvals: makeDenyingGate(),
        approvalRequired: true,
        trustConfigPaths: [],
      });
      await expect(tool.run({ path: "fresh" }, makeCtx(workspace))).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
      await expect(stat(join(workspace, "fresh", ".git"))).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("os.git.init on an existing repo with nothing to change asks nobody", async () => {
    const prompts: ApprovalRequest[] = [];
    const result = await buildOsGitInitTool(recording(prompts)).run({}, makeCtx(repo));
    expect(result.status).toBe("ok");
    expect(result.details.alreadyInitialised).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("a repository outside the workspace is not a workspace write", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "atomic-git-elsewhere-"));
    try {
      await writeRepoFile(repo, "new.txt", "n\n");
      const prompts: ApprovalRequest[] = [];
      const result = await buildOsGitAddTool(recording(prompts)).run(
        { repo, all: true },
        makeCtx(elsewhere),
      );
      expect(result.status).toBe("ok");
      expect(prompts).toHaveLength(1);
      // The temp dir is outside home on macOS/Linux CI (`other`); a host
      // whose TMPDIR sits under $HOME lands one rung lower. Either way
      // it must not be the level-2 workspace rung.
      expect(["other", "fs_write_home"]).toContain(prompts[0]!.category);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("becomes trust_config when the agent's own config lives inside the repository", async () => {
    await writeRepoFile(repo, "new.txt", "n\n");
    const prompts: ApprovalRequest[] = [];
    const options: FsDangerousToolOptions = {
      approvals: makeRecordingGate(prompts),
      approvalRequired: true,
      // Not on disk yet — a fresh install's `.env` is the realistic case.
      trustConfigPaths: [join(repo, ".atomic", "config.json"), join(repo, ".atomic", ".env")],
    };
    const result = await buildOsGitCheckoutTool(options).run(
      { branch: "escalate", create: true },
      makeCtx(repo),
    );
    expect(result.status).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.category).toBe("trust_config");
  });

  it("stays a workspace write when the trust config lives elsewhere", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "atomic-git-trust-"));
    try {
      await writeRepoFile(repo, "new.txt", "n\n");
      const prompts: ApprovalRequest[] = [];
      const options: FsDangerousToolOptions = {
        approvals: makeRecordingGate(prompts),
        approvalRequired: true,
        trustConfigPaths: [join(elsewhere, "config.json")],
      };
      const result = await buildOsGitAddTool(options).run({ all: true }, makeCtx(repo));
      expect(result.status).toBe("ok");
      expect(prompts[0]!.category).toBe("fs_write_workspace");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("the commit preview shows the exact command line including the signing override", async () => {
    await writeRepoFile(repo, "new.txt", "n\n");
    await runGitRaw(repo, ["add", "new.txt"]);
    const prompts: ApprovalRequest[] = [];
    await buildOsGitCommitTool(recording(prompts)).run(
      { message: "feat: add parser" },
      makeCtx(repo),
    );
    // The preview leads with the command line and then says what the
    // commit sweeps up, so both halves are pinned rather than the
    // string as a whole.
    expect(prompts[0]!.preview).toContain(
      "git -c commit.gpgsign=false commit -m 'feat: add parser'",
    );
    expect(prompts[0]!.preview?.startsWith("git ")).toBe(true);
  });
});

describe("formatGitCommandLine", () => {
  it("quotes only what a shell would split or expand", () => {
    expect(formatGitCommandLine(["switch", "-c", "feat/x", "HEAD~1"])).toBe(
      "git switch -c feat/x HEAD~1",
    );
    expect(formatGitCommandLine(["commit", "-m", "it's done", ""])).toBe(
      "git commit -m 'it'\\''s done' ''",
    );
  });
});
