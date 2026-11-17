import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../sandbox/command-runner.js";
import { createEmptySessionState, type SessionState } from "../session/session-state.js";
import { startWorktreeSession, type WorktreeSessionRuntime } from "./session-worktree-start.js";

function fakeRuntime(stateDir: string, workingDir: string) {
  const saved = new Map<string, SessionState>();
  let n = 0;
  const runtime: WorktreeSessionRuntime = {
    config: { paths: { stateDir } },
    createSession: () => createEmptySessionState({ id: `s-test000${++n}`, workingDir }),
    sessionStore: { load: (id) => saved.get(id) ?? null, save: (s) => void saved.set(s.id, s) },
  };
  return { runtime, saved };
}

describe("startWorktreeSession (ATO-576)", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "atomic-wt-start-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("explains and saves nothing outside a git repository", async () => {
    const plain = join(root, "plain");
    await mkdir(plain);
    const { runtime, saved } = fakeRuntime(join(root, "state"), plain);
    const started = await startWorktreeSession(runtime);
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.message).toMatch(/not inside a git repository/);
    expect(saved.size).toBe(0);
  });

  it("saves the new session bound to its worktree", async () => {
    const repo = join(root, "repo");
    await mkdir(repo);
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) {
      await runCommand("git", args, { cwd: repo });
    }
    await writeFile(join(repo, "a.txt"), "a\n");
    await runCommand("git", ["add", "."], { cwd: repo });
    await runCommand("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], { cwd: repo });
    const { runtime, saved } = fakeRuntime(join(root, "state"), repo);
    const started = await startWorktreeSession(runtime);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.session.worktree?.branch).toBe("atomic/session-test0001");
    expect(started.session.workingDir).toBe(started.session.worktree?.path);
    expect(saved.get(started.session.id)?.worktree).toEqual(started.session.worktree);
    expect(started.notice).toContain("atomic/session-test0001");
  });
});
