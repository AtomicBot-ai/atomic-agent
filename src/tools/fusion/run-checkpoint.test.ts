import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnOwnerProbe } from "../../session/turn-owner.js";
import {
  FusionRunStore,
  toolHasSideEffects,
  type FusionRunCheckpoint,
} from "./run-checkpoint.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

const TASKS = [
  { id: "t1", title: "One" },
  { id: "t2", title: "Two" },
];

/** A process that is not this one and is gone. */
function deadProbe(pid = 4_000_001): TurnOwnerProbe {
  return {
    pid,
    host: "test-host",
    hostUptime: () => 1_000,
    isAlive: () => false,
    processStartOf: () => null,
  };
}

/** Another process that is still running. */
function aliveProbe(pid: number): TurnOwnerProbe {
  return { ...deadProbe(pid), isAlive: () => true };
}

function row(
  id: string,
  over: Partial<WorkerTaskResult> = {},
): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({
      id,
      title: id,
      reason: "reply",
      stepCount: 2,
      durationMs: 10,
    }),
    reply: `reply of ${id}`,
    ...over,
  };
}

describe("fusion run checkpoints (ATO-617)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (store: FusionRunStore) =>
    store.start({
      sessionId: "s-1",
      workingDir: "/repo",
      originalRequest: "build it",
      args: { tasks: TASKS.map((t) => ({ ...t, instructions: "x" })) },
      tasks: TASKS,
      waveCount: 2,
    });

  it("writes the run as soon as it starts", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    const saved = store.load(run.runId)!;
    expect(saved.sessionId).toBe("s-1");
    expect(saved.originalRequest).toBe("build it");
    expect(saved.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(saved.tasks.every((t) => t.result === undefined)).toBe(true);
    expect(saved.state).toBe("running");
  });

  it("writes a finished task and its spend at once", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"), 0.25);
    const saved = store.load(run.runId)!;
    expect(saved.tasks[0]!.result?.status).toBe("ok");
    expect(saved.tasks[0]!.result?.reply).toBe("reply of t1");
    expect(saved.tasks[1]!.result).toBeUndefined();
    expect(saved.spentUsd).toBeCloseTo(0.25);
  });

  it("writes the wave count after a wave", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordWave(1);
    expect(store.load(run.runId)!.wavesDone).toBe(1);
  });

  it("deletes a run that completed", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"));
    run.recordTask(row("t2"));
    run.finish("complete");
    expect(store.load(run.runId)).toBeNull();
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("keeps a stopped run and offers it", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(row("t1"));
    run.finish("interrupted");
    const offered = store.listResumable("s-1");
    expect(offered.map((r) => r.runId)).toEqual([run.runId]);
    expect(offered[0]!.state).toBe("interrupted");
  });

  it("never offers a run this process is still working on", () => {
    const store = new FusionRunStore({ dir });
    start(store);
    expect(store.listResumable("s-1")).toEqual([]);
  });

  it("offers a run whose process died, but not one whose process is alive", () => {
    const dead = start(new FusionRunStore({ dir, probe: deadProbe(4_000_001) }));
    const alive = start(new FusionRunStore({ dir, probe: aliveProbe(4_000_002) }));
    // A fresh process reads both files: pid 4_000_001 is gone, 4_000_002 is not.
    const reader = new FusionRunStore({
      dir,
      probe: {
        ...deadProbe(1),
        isAlive: (pid) => pid === 4_000_002,
      },
    });
    const offered = reader.listResumable().map((r) => r.runId);
    expect(offered).toContain(dead.runId);
    expect(offered).not.toContain(alive.runId);
  });

  it("narrows to one session", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.finish("interrupted");
    expect(store.listResumable("s-other")).toEqual([]);
  });

  it("drops runs past the retention", () => {
    let now = 1_000_000;
    const store = new FusionRunStore({ dir, now: () => now, retentionMs: 1_000 });
    const run = start(store);
    run.finish("interrupted");
    now += 5_000;
    expect(store.listResumable()).toEqual([]);
    expect(existsSync(join(dir, `${run.runId}.json`))).toBe(false);
  });

  it("discards a stopped run, and refuses one in flight", () => {
    const store = new FusionRunStore({ dir });
    const live = start(store);
    expect(store.discard(live.runId)).toBe(false);
    live.finish("interrupted");
    expect(store.discard(live.runId)).toBe(true);
    expect(store.load(live.runId)).toBeNull();
  });

  it("never reads a run id that could leave the directory", () => {
    const store = new FusionRunStore({ dir });
    expect(store.load("../../etc/passwd")).toBeNull();
    expect(FusionRunStore.isValidRunId("fr-abc_123")).toBe(true);
    expect(FusionRunStore.isValidRunId("a/b")).toBe(false);
  });

  it("skips a corrupt file instead of failing", () => {
    writeFileSync(join(dir, "fr-bad.json"), "{not json", "utf8");
    const store = new FusionRunStore({ dir });
    expect(store.listResumable()).toEqual([]);
  });

  it("records side effects as the call starts, before the task finishes", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.noteTool("t2", "os.fs.write");
    expect(store.load(run.runId)!.tasks[1]!.sideEffects).toBe(false);
    run.noteTool("t2", "os.shell.run");
    const saved = store.load(run.runId)!.tasks[1]!;
    expect(saved.sideEffects).toBe(true);
    expect(saved.sideEffectTools).toEqual(["os.shell.run"]);
  });

  it("reads side effects off a finished row's tool counts too", () => {
    const store = new FusionRunStore({ dir });
    const run = start(store);
    run.recordTask(
      row("t1", {
        tools: { calls: 2, errors: 0, writes: 1, byTool: { "os.fs.write": 1, "mcp.github.create_issue": 1 } },
      }),
    );
    const saved = store.load(run.runId)!.tasks[0]!;
    expect(saved.sideEffects).toBe(true);
    expect(saved.sideEffectTools).toEqual(["mcp.github.create_issue"]);
  });

  it("continues a resumed run in the same file, finished tasks kept", () => {
    const store = new FusionRunStore({ dir });
    const first = start(store);
    first.recordTask(row("t1"), 1);
    first.finish("interrupted");
    const before = store.load(first.runId) as FusionRunCheckpoint;
    const again = store.start({
      runId: first.runId,
      sessionId: "s-1",
      workingDir: "/repo",
      args: before.args,
      tasks: TASKS,
      waveCount: 2,
      resumedFrom: before,
    });
    expect(again.runId).toBe(first.runId);
    const saved = store.load(first.runId)!;
    expect(saved.tasks[0]!.result?.status).toBe("ok");
    expect(saved.spentUsd).toBe(1);
    expect(saved.resumes).toBe(1);
    expect(saved.state).toBe("running");
  });
});

describe("toolHasSideEffects", () => {
  it("treats file tools and reads as safe to repeat", () => {
    for (const tool of ["os.fs.write", "os.fs.read", "os.web.search", "os.git.diff", "reply"]) {
      expect(toolHasSideEffects(tool)).toBe(false);
    }
  });
  it("treats commands, pushes, requests and MCP tools as side effects", () => {
    for (const tool of ["os.shell.run", "os.git.push", "os.http.request", "os.email.send", "mcp.linear.save_issue", "image.generate"]) {
      expect(toolHasSideEffects(tool)).toBe(true);
    }
  });
});
