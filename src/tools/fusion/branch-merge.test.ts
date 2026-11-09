import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { makeGitRepo, runGitRaw, writeRepoFile } from "../os/git/test-helpers.js";
import {
  applyMergeOutcome,
  inputReplacement,
  rebaseScope,
  rebaseTask,
  runIsolatedWave,
  type IsolatedWaveInput,
} from "./branch-merge.js";
import { createBranchSet, BRANCH_MERGE_DIR } from "./branch-workspace.js";
import type { DelegateTask } from "./delegate-args.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionRunStore, type FusionRunCheckpoint } from "./run-checkpoint.js";
import type { WorkerTaskResult, WorkerTaskStatus } from "./worker-result.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function gitRepo(files: Record<string, string>): Promise<string> {
  const repo = await makeGitRepo("atag-branch-");
  cleanup.push(repo);
  for (const [path, content] of Object.entries(files)) {
    await writeRepoFile(repo, path, content);
  }
  await runGitRaw(repo, ["add", "-A"]);
  await runGitRaw(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

async function plainDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atag-branch-plain-"));
  cleanup.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "atag-branch-tmp-"));
  cleanup.push(dir);
  return dir;
}

function row(id: string, status: WorkerTaskStatus = "ok"): WorkerTaskResult {
  return {
    id,
    title: id,
    status,
    reply: "done",
    stepCount: 1,
    durationMs: 1,
    tools: { calls: 1, errors: 0, writes: 1, byTool: {} },
  };
}

function task(id: string): DelegateTask {
  return { id, title: id, instructions: `do ${id}` } as DelegateTask;
}

/** A fake wave: each task's edit runs inside the workspace it was given. */
function fakeRun(
  edits: Record<string, (dir: string) => Promise<void>>,
  statuses: Record<string, WorkerTaskStatus> = {},
  seen: Record<string, string> = {},
): IsolatedWaveInput["run"] {
  return async (tasks, taskWorkspace) => {
    const out: WorkerTaskResult[] = [];
    for (const t of tasks) {
      const ws = taskWorkspace?.(t.id);
      if (ws === undefined) throw new Error(`no workspace for ${t.id}`);
      seen[t.id] = ws.workingDir;
      await edits[t.id]?.(ws.workingDir);
      out.push(row(t.id, statuses[t.id] ?? "ok"));
    }
    return out;
  };
}

const lines = (n: number, tag = "line"): string =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join("\n") + "\n";

describe("createBranchSet", () => {
  it("makes a detached worktree per task holding uncommitted and untracked work, and removes them all", async () => {
    const repo = await gitRepo({ "a.txt": "committed\n" });
    await writeFile(join(repo, "a.txt"), "uncommitted\n");
    await writeFile(join(repo, "new.txt"), "untracked\n");
    const set = await createBranchSet(repo, ["one", "two"], { tmpRoot: await tmpRoot() });
    expect(set).not.toBeNull();
    expect(set!.method).toBe("worktree");
    for (const ws of set!.workspaces.values()) {
      expect(await readFile(join(ws.dir, "a.txt"), "utf8")).toBe("uncommitted\n");
      expect(await readFile(join(ws.dir, "new.txt"), "utf8")).toBe("untracked\n");
    }
    const before = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(before).toHaveLength(4); // the repo, the base, two tasks
    // The person's working tree and stash list are untouched.
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("uncommitted\n");
    expect((await runGitRaw(repo, ["stash", "list"])).stdout.trim()).toBe("");
    await set!.cleanup();
    const after = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(after).toHaveLength(1);
  });

  it("falls back to a folder copy outside git", async () => {
    const dir = await plainDir({ "notes.md": "hello\n" });
    const root = await tmpRoot();
    const set = await createBranchSet(dir, ["one"], { tmpRoot: root, platform: "linux" });
    expect(set!.method).toBe("copy");
    const ws = set!.workspaces.get("one")!;
    expect(await readFile(join(ws.dir, "notes.md"), "utf8")).toBe("hello\n");
    await set!.cleanup();
    expect(await readdir(root)).toEqual([]);
  });

  it("returns null for a tree too large to copy", async () => {
    const dir = await plainDir({ "big.bin": "x".repeat(100) });
    const set = await createBranchSet(dir, ["one"], {
      tmpRoot: await tmpRoot(),
      platform: "linux",
      maxCopyBytes: 10,
    });
    expect(set).toBeNull();
  });
});

describe("runIsolatedWave", () => {
  it("merges two tasks that edited different files", async () => {
    const repo = await gitRepo({ "a.txt": "a\n", "b.txt": "b\n" });
    const seen: Record<string, string> = {};
    const wave = await runIsolatedWave({
      realDir: repo,
      tasks: [task("one"), task("two")],
      writeScope: [repo],
      inputs: [],
      options: { tmpRoot: await tmpRoot() },
      run: fakeRun(
        {
          one: (dir) => writeFile(join(dir, "a.txt"), "a from one\n"),
          two: async (dir) => {
            await writeFile(join(dir, "b.txt"), "b from two\n");
            await writeFile(join(dir, "c.txt"), "new from two\n");
          },
        },
        {},
        seen,
      ),
    });
    expect(seen.one).not.toBe(repo);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a from one\n");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("b from two\n");
    expect(await readFile(join(repo, "c.txt"), "utf8")).toBe("new from two\n");
    expect(wave.merges).toEqual([]);
    expect(wave.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(wave.results[1]!.notes).toContain("merged 2 files back from its own workspace");
    // Workspaces are gone.
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });

  it("merges two tasks that edited different parts of one file", async () => {
    const repo = await gitRepo({ "a.txt": lines(20) });
    await runIsolatedWave({
      realDir: repo,
      tasks: [task("top"), task("bottom")],
      writeScope: [repo],
      inputs: [],
      options: { tmpRoot: await tmpRoot() },
      run: fakeRun({
        top: (dir) => writeFile(join(dir, "a.txt"), lines(20).replace("line 1\n", "TOP\n")),
        bottom: (dir) => writeFile(join(dir, "a.txt"), lines(20).replace("line 20\n", "BOTTOM\n")),
      }),
    });
    const merged = await readFile(join(repo, "a.txt"), "utf8");
    expect(merged.startsWith("TOP\n")).toBe(true);
    expect(merged.endsWith("BOTTOM\n")).toBe(true);
  });

  it("leaves a conflicting file untouched and hands back a merge task", async () => {
    const repo = await gitRepo({ "a.txt": "one line\n" });
    const wave = await runIsolatedWave({
      realDir: repo,
      tasks: [task("first"), task("second")],
      writeScope: [repo],
      inputs: [],
      options: { tmpRoot: await tmpRoot() },
      run: fakeRun({
        first: (dir) => writeFile(join(dir, "a.txt"), "first's line\n"),
        second: (dir) => writeFile(join(dir, "a.txt"), "second's line\n"),
      }),
    });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("first's line\n");
    expect(wave.results[0]!.status).toBe("ok");
    expect(wave.results[1]!.status).toBe("needs_orchestrator");
    expect(wave.results[1]!.error).toMatch(/merge conflict in a\.txt/);
    expect(wave.merges).toHaveLength(1);
    expect(wave.merges[0]).toMatchObject({ id: "merge-second", files: ["a.txt"] });
    const saved = join(repo, BRANCH_MERGE_DIR, "t1-second", "a.txt");
    expect(await readFile(`${saved}.task`, "utf8")).toBe("second's line\n");
    expect(await readFile(`${saved}.base`, "utf8")).toBe("one line\n");
  });

  it("refuses a declared input the task wiped", async () => {
    const repo = await gitRepo({ "sales.csv": lines(40, "row"), "out.txt": "x\n" });
    const wave = await runIsolatedWave({
      realDir: repo,
      tasks: [task("clean")],
      writeScope: [repo],
      inputs: ["sales.csv"],
      options: { tmpRoot: await tmpRoot() },
      run: fakeRun({
        clean: async (dir) => {
          await writeFile(join(dir, "sales.csv"), "row 1\n");
          await writeFile(join(dir, "out.txt"), "report\n");
        },
      }),
    });
    expect(await readFile(join(repo, "sales.csv"), "utf8")).toBe(lines(40, "row"));
    expect(await readFile(join(repo, "out.txt"), "utf8")).toBe("report\n");
    expect(wave.results[0]!.status).toBe("needs_orchestrator");
    expect(wave.results[0]!.error).toMatch(/merge refused for sales\.csv/);
  });

  it("discards a failed task's changes", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const wave = await runIsolatedWave({
      realDir: repo,
      tasks: [task("bad")],
      writeScope: [repo],
      inputs: [],
      options: { tmpRoot: await tmpRoot() },
      run: fakeRun(
        { bad: (dir) => writeFile(join(dir, "a.txt"), "") },
        { bad: "failed" },
      ),
    });
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a\n");
    expect(wave.results[0]!.notes?.join(" ")).toMatch(/discarded with its workspace/);
  });

  it("merges a copy workspace back outside git", async () => {
    const dir = await plainDir({ "notes.md": "hello\n" });
    await runIsolatedWave({
      realDir: dir,
      tasks: [task("one")],
      writeScope: [dir],
      inputs: [],
      options: { tmpRoot: await tmpRoot(), platform: "linux" },
      run: fakeRun({ one: (ws) => writeFile(join(ws, "notes.md"), "hello world\n") }),
    });
    expect(await readFile(join(dir, "notes.md"), "utf8")).toBe("hello world\n");
  });

  it("removes the workspaces when the run throws", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const root = await tmpRoot();
    await expect(
      runIsolatedWave({
        realDir: repo,
        tasks: [task("one")],
        writeScope: [repo],
        inputs: [],
        options: { tmpRoot: root },
        run: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(await readdir(root)).toEqual([]);
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });
});

describe("inputReplacement / applyMergeOutcome", () => {
  it("allows an edit in place and refuses a removal or a wipe", () => {
    const base = Buffer.from(lines(10));
    expect(inputReplacement(base, Buffer.from(lines(9)))).toBeUndefined();
    expect(inputReplacement(base, null)).toMatch(/remove/);
    expect(inputReplacement(base, Buffer.from(lines(2)))).toMatch(/10 → 2 lines/);
    expect(inputReplacement(null, Buffer.from("x"))).toBeUndefined();
  });

  it("leaves a clean row as it was", () => {
    const r = row("t");
    expect(applyMergeOutcome(r, { taskId: "t", applied: [], conflicts: [], refused: [] })).toBe(r);
  });
});

describe("rebaseTask / rebaseScope", () => {
  it("points paths into the folder at the workspace, under either spelling", () => {
    const roots = ["/var/p", "/private/var/p"];
    const t = rebaseTask(
      {
        id: "t",
        title: "t",
        instructions: "edit /private/var/p/a.ts and /var/p/b.ts, not /var/plan.md",
        files: ["/var/p/a.ts", "rel.ts", "/elsewhere/c.ts"],
      },
      roots,
      "/ws/t0",
    );
    expect(t.instructions).toContain("edit /ws/t0/a.ts and /ws/t0/b.ts, not /var/plan.md");
    expect(t.files).toEqual(["/ws/t0/a.ts", "rel.ts", "/elsewhere/c.ts"]);
    expect(rebaseScope(["/var/p/src", "/other"], roots, "/ws/t0")).toEqual([
      "/ws/t0/src",
      "/other",
      "/ws/t0",
    ]);
  });
});

describe("fusion.delegate with isolation", () => {
  const logger = new StructuredLogger({ level: "error", sinks: [] });
  function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
    return {
      stored: "fusion",
      effective: "fusion",
      orchestratorProviderId: "cloud",
      orchestratorModel: "big",
      workerProviderId: "local",
      workerModel: "small",
      workers: 2,
      workersPinned: true,
      workerMaxSteps: 7,
      workerTimeoutMs: 60_000,
      primaryProviderId: "cloud",
      degraded: null,
      ...over,
    };
  }
  function deps(repo: string, over: Partial<ResolvedRunMode>) {
    let minted = 0;
    const dirs: string[] = [];
    const d: FusionDelegateDeps = {
      runTurn: async (session) => {
        const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
        dirs.push(session.workingDir);
        await writeFile(join(session.workingDir, `${taskId}.txt`), `${taskId}\n`);
        return { session, reason: "reply", stepCount: 1 } as RunTurnResult;
      },
      createEphemeralSession: (meta, workingDir) => {
        minted += 1;
        return createEmptySessionState({
          id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
          workingDir: workingDir ?? repo,
          metadata: { fusionWorker: { ...meta } },
        });
      },
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
      approvalRequired: false,
      emitEvent: () => {},
      workingDir: repo,
      slotManager: { poolSize: () => 4 },
      resolveRunMode: () => mode(over),
      workerSupportsSlotAffinity: () => false,
      warmWorkerBackend: async () => {},
      outputCharCap: 4000,
      logger,
    };
    return { d, dirs };
  }
  const args = {
    tasks: [
      { id: "one", title: "One", instructions: "write one.txt" },
      { id: "two", title: "Two", instructions: "write two.txt" },
    ],
  };
  const ctx = (repo: string) => ({
    workingDir: repo,
    sessionId: "s-p",
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  it("off (the default): workers run in the folder itself", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const { d, dirs } = deps(repo, {});
    const result = await buildFusionDelegateTool(d).run(args, ctx(repo));
    expect(dirs).toEqual([repo, repo]);
    expect(result.details.merges).toBeUndefined();
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("one\n");
  });

  it("worktree: a task reaches the checkpoint only after its merge", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const { d } = deps(repo, { isolation: "worktree" });
    const runsDir = await tmpRoot();
    const store = new FusionRunStore({ dir: runsDir });
    d.runCheckpoints = store;
    const seen: Record<string, FusionRunCheckpoint | null> = {};
    let oneOnDiskAtTwo = false;
    const runTurn = d.runTurn;
    d.runTurn = async (session, message, options) => {
      const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
      const [file] = (await readdir(runsDir)).filter((f) => f.endsWith(".json"));
      seen[taskId] = store.load(file!.replace(/\.json$/, ""));
      if (taskId === "two") {
        oneOnDiskAtTwo = await readFile(join(repo, "one.txt"), "utf8").then(() => true, () => false);
      }
      return runTurn(session, message, options);
    };
    await buildFusionDelegateTool(d).run(
      {
        tasks: [
          { id: "one", title: "One", instructions: "write one.txt" },
          { id: "side", title: "Side", instructions: "write side.txt" },
          { id: "two", title: "Two", instructions: "write two.txt" },
        ],
        maxWorkers: 1,
        contract: {
          provides: [{ task: "one", kind: "other", name: "done" }],
          requires: [{ task: "two", name: "done" }],
        },
      },
      ctx(repo),
    );
    // "side" runs in the same wave as "one", after it: nothing merged yet.
    expect(seen.side!.tasks.find((t) => t.id === "one")!.result).toBeUndefined();
    expect(seen.two!.tasks.find((t) => t.id === "one")!.result?.status).toBe("ok");
    expect(oneOnDiskAtTwo).toBe(true);
  });

  it("worktree: each worker runs in its own workspace and the work lands in the folder", async () => {
    const repo = await gitRepo({ "a.txt": "a\n" });
    const { d, dirs } = deps(repo, { isolation: "worktree" });
    await buildFusionDelegateTool(d).run(args, ctx(repo));
    expect(dirs).toHaveLength(2);
    expect(dirs.every((dir) => dir !== repo)).toBe(true);
    expect(new Set(dirs).size).toBe(2);
    expect(await readFile(join(repo, "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(repo, "two.txt"), "utf8")).toBe("two\n");
    const list = (await runGitRaw(repo, ["worktree", "list"])).stdout.trim().split("\n");
    expect(list).toHaveLength(1);
  });
});
