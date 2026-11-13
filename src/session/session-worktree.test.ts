import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../sandbox/command-runner.js";
import { createEmptySessionState } from "./session-state.js";
import {
  bindSessionWorktree,
  isRegenerableIgnoredPath,
  isWorktreeBranchMerged,
  listSessionWorktreeMarkers,
  markerPathFor,
  removeSessionWorktree,
  SessionWorktreeError,
  unbindSessionWorktree,
  worktreeRemovalPreflight,
} from "./session-worktree.js";
import { cleanupIdleSessionWorktrees } from "./session-worktree-cleanup.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", args, { cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeRepo(root: string, withCommit = true): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(join(repo, "pkg"), { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "commit.gpgsign", "false");
  if (withCommit) {
    await writeFile(join(repo, "pkg", "a.txt"), "one\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-q", "-m", "init");
  }
  return realpath(repo);
}

describe("session worktree (ATO-576)", () => {
  let root: string;
  let worktreesDir: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "atomic-session-wt-")));
    worktreesDir = join(root, "state", "worktrees");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses outside a git repository with a clear message and creates nothing", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    const session = createEmptySessionState({ id: "s-abc12345", workingDir: plain });
    const error = await bindSessionWorktree(session, { worktreesDir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionWorktreeError);
    expect((error as SessionWorktreeError).code).toBe("not-git");
    expect((error as Error).message).toMatch(/not inside a git repository/);
    expect(existsSync(worktreesDir)).toBe(false);
  });

  it("refuses a repository with no commit yet", async () => {
    const repo = await makeRepo(root, false);
    const session = createEmptySessionState({ id: "s-abc12345", workingDir: repo });
    const error = await bindSessionWorktree(session, { worktreesDir }).catch((e: unknown) => e);
    expect((error as SessionWorktreeError).code).toBe("no-commit");
  });

  it("binds a new session to its own worktree and keeps the subfolder", async () => {
    const repo = await makeRepo(root);
    const session = createEmptySessionState({ id: "s-abc12345-xyz", workingDir: join(repo, "pkg") });
    const bound = await bindSessionWorktree(session, { worktreesDir });
    const wt = bound.worktree!;
    expect(wt.repoRoot).toBe(repo);
    expect(wt.branch).toBe("atomic/session-abc12345");
    expect(wt.baseBranch).toBe("main");
    expect(wt.path.startsWith(await realpath(worktreesDir))).toBe(true);
    expect(bound.workingDir).toBe(join(wt.path, "pkg"));
    expect(existsSync(join(bound.workingDir, "a.txt"))).toBe(true);
    expect(await git(repo, "branch", "--list", wt.branch)).toContain(wt.branch);
    expect(existsSync(markerPathFor(wt.path))).toBe(true);
    // The marker sits outside the worktree: the new worktree is clean.
    expect(await git(wt.path, "status", "--porcelain")).toBe("");
    expect(unbindSessionWorktree(bound).workingDir).toBe(join(repo, "pkg"));
    expect(unbindSessionWorktree(bound).worktree).toBeUndefined();

    // A second session with a colliding short id gets its own branch and folder.
    const other = await bindSessionWorktree(createEmptySessionState({ id: "s-abc12345-other", workingDir: repo }), { worktreesDir });
    expect(other.worktree!.branch).not.toBe(wt.branch);
    expect(other.worktree!.path).not.toBe(wt.path);
    expect((await listSessionWorktreeMarkers(worktreesDir)).map(m => m.sessionId).sort())
      .toEqual(["s-abc12345-other", "s-abc12345-xyz"]);
  });

  it("refuses to remove a worktree with uncommitted changes", async () => {
    const repo = await makeRepo(root);
    const bound = await bindSessionWorktree(createEmptySessionState({ id: "s-dirty001", workingDir: repo }), { worktreesDir });
    const wt = bound.worktree!;
    await writeFile(join(wt.path, "new-file.txt"), "work in progress\n");
    const preflight = await worktreeRemovalPreflight(wt);
    expect(preflight).toEqual({ ok: false, reason: "the worktree has uncommitted changes" });
    expect(await removeSessionWorktree(wt)).toBe("the worktree has uncommitted changes");
    expect(existsSync(join(wt.path, "new-file.txt"))).toBe(true);
  });

  it("counts regenerable ignored folders as safe and everything else ignored as work", () => {
    expect(isRegenerableIgnoredPath("node_modules/")).toBe(true);
    expect(isRegenerableIgnoredPath("pkg/node_modules/")).toBe(true);
    expect(isRegenerableIgnoredPath(".DS_Store")).toBe(true);
    expect(isRegenerableIgnoredPath(".env")).toBe(false);
    expect(isRegenerableIgnoredPath("dist/")).toBe(false);
    expect(isRegenerableIgnoredPath("notes.md")).toBe(false);
  });

  it("cleanup keeps an idle merged worktree that holds an ignored .env", async () => {
    const repo = await makeRepo(root);
    await writeFile(join(repo, ".gitignore"), ".env\nnode_modules/\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-q", "-m", "ignore");
    const withEnv = (await bindSessionWorktree(createEmptySessionState({ id: "s-envfile1", workingDir: repo }), { worktreesDir })).worktree!;
    const onlyCache = (await bindSessionWorktree(createEmptySessionState({ id: "s-cache001", workingDir: repo }), { worktreesDir })).worktree!;
    await writeFile(join(withEnv.path, ".env"), "SECRET=1\n");
    await mkdir(join(onlyCache.path, "node_modules", "x"), { recursive: true });
    await writeFile(join(onlyCache.path, "node_modules", "x", "index.js"), "\n");
    // Ignored files do not show in plain status: the old preflight saw a clean tree.
    expect(await git(withEnv.path, "status", "--porcelain")).toBe("");
    expect(await isWorktreeBranchMerged(withEnv)).toBe(true);

    const now = Date.now();
    const result = await cleanupIdleSessionWorktrees({
      worktreesDir,
      lastActiveAt: () => now - 3 * 86_400_000,
      now: () => now,
    });

    expect(result.removed.map(m => m.sessionId)).toEqual(["s-cache001"]);
    expect(existsSync(onlyCache.path)).toBe(false);
    const kept = result.kept.find(k => k.marker.sessionId === "s-envfile1");
    expect(kept?.reason).toBe("the worktree has ignored files that would be deleted: .env");
    expect(existsSync(join(withEnv.path, ".env"))).toBe(true);
    expect(existsSync(markerPathFor(withEnv.path))).toBe(true);
  });

  it("removes a clean merged worktree and its branch", async () => {
    const repo = await makeRepo(root);
    const bound = await bindSessionWorktree(createEmptySessionState({ id: "s-clean001", workingDir: repo }), { worktreesDir });
    const wt = bound.worktree!;
    expect(await isWorktreeBranchMerged(wt)).toBe(true);
    expect(await removeSessionWorktree(wt)).toBeNull();
    expect(existsSync(wt.path)).toBe(false);
    expect(existsSync(markerPathFor(wt.path))).toBe(false);
    expect(await git(repo, "branch", "--list", wt.branch)).toBe("");
  });

  it("cleanup removes only idle, merged, clean worktrees of inactive sessions", async () => {
    const repo = await makeRepo(root);
    const make = async (id: string) =>
      (await bindSessionWorktree(createEmptySessionState({ id, workingDir: repo }), { worktreesDir })).worktree!;
    const merged = await make("s-merged01");
    const unmerged = await make("s-unmerg01");
    const dirty = await make("s-dirtyy01");
    const active = await make("s-active01");
    const recent = await make("s-recent01");

    await writeFile(join(unmerged.path, "b.txt"), "b\n");
    await git(unmerged.path, "add", ".");
    await git(unmerged.path, "commit", "-q", "-m", "work");
    await writeFile(join(dirty.path, "c.txt"), "c\n");

    const now = Date.now();
    const removedIds: string[] = [];
    const result = await cleanupIdleSessionWorktrees({
      worktreesDir,
      activeSessionIds: new Set(["s-active01"]),
      lastActiveAt: (id) => (id === "s-recent01" ? now : now - 3 * 86_400_000),
      now: () => now,
      onRemoved: (m) => removedIds.push(m.sessionId),
    });

    expect(result.removed.map(m => m.sessionId)).toEqual(["s-merged01"]);
    expect(removedIds).toEqual(["s-merged01"]);
    expect(existsSync(merged.path)).toBe(false);
    const reasons = Object.fromEntries(result.kept.map(k => [k.marker.sessionId, k.reason]));
    expect(reasons["s-unmerg01"]).toBe("the branch has commits that are not merged");
    expect(reasons["s-dirtyy01"]).toBe("the worktree has uncommitted changes");
    expect(reasons["s-active01"]).toBe("the session is active");
    expect(reasons["s-recent01"]).toBe("the session was used recently");
    for (const wt of [unmerged, dirty, active, recent]) expect(existsSync(wt.path)).toBe(true);
    // The unmerged commit is still reachable from its branch.
    expect(await git(repo, "log", "--oneline", "-1", unmerged.branch)).toContain("work");
    expect((await readdir(join(worktreesDir))).length).toBe(1);
  });
});
