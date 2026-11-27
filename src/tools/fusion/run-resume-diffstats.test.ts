import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnOwnerProbe } from "../../session/turn-owner.js";
import { FusionRunStore } from "./run-checkpoint.js";
import { planResume } from "./run-resume.js";
import { sumDiffStats } from "./worker-diffstats.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

/**
 * A resumed run's carried rows keep the files they changed (ATO-1756):
 * the checkpoint stores each finished row's `diffstats`, and the resume
 * hands them back, so the result and the "Changed files" card still list
 * them after a restart.
 */

const TASKS = [
  { id: "t1", title: "One" },
  { id: "t2", title: "Two" },
];

/** The process that wrote the run is gone, so it is offered for resuming. */
const deadProbe: TurnOwnerProbe = {
  pid: 4_000_001,
  host: "test-host",
  hostUptime: () => 1_000,
  isAlive: () => false,
  processStartOf: () => null,
};

function row(id: string, over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
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

describe("changed files survive a resume (ATO-1756)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-runs-diffstats-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (store: FusionRunStore) =>
    store.start({
      sessionId: "s-1",
      workingDir: "/repo",
      args: { tasks: TASKS.map((t) => ({ ...t, instructions: "x" })) },
      tasks: TASKS,
      waveCount: 1,
    });

  it("keeps a finished task's files in the checkpoint and returns them on the carried row", () => {
    const files = [
      { path: "/repo/a.ts", added: 12, removed: 3 },
      { path: "/repo/b.md", added: 4, removed: 0 },
    ];
    const run = start(new FusionRunStore({ dir, probe: deadProbe }));
    run.recordTask(row("t1", { diffstats: files }));
    run.finish("interrupted");

    // A fresh store, as after a restart: only the file on disk is read.
    const after = new FusionRunStore({ dir, probe: deadProbe });
    const saved = after.load(run.runId)!;
    expect(saved.tasks.find((t) => t.id === "t1")?.result?.diffstats).toEqual(files);

    const plan = planResume(saved);
    expect(plan.carried.map((r) => r.id)).toEqual(["t1"]);
    expect(plan.carried[0]!.diffstats).toEqual(files);
    expect(plan.rerun).toEqual(["t2"]);
    // What fusion.delegate sums into details.diffstats for the card.
    expect(sumDiffStats(plan.carried)).toEqual(files);
  });

  it("writes no field for a task that changed no file", () => {
    const run = start(new FusionRunStore({ dir, probe: deadProbe }));
    run.recordTask(row("t1"));
    run.recordTask(row("t2", { diffstats: [] }));
    run.finish("interrupted");
    const saved = new FusionRunStore({ dir, probe: deadProbe }).load(run.runId)!;
    for (const task of saved.tasks) expect(task.result).not.toHaveProperty("diffstats");
    for (const r of planResume(saved).carried) expect(r).not.toHaveProperty("diffstats");
  });

  it("loads a checkpoint written before the field existed: no files, no crash", () => {
    const run = start(new FusionRunStore({ dir, probe: deadProbe }));
    run.recordTask(row("t1"));
    run.finish("interrupted");
    // The file as an older agent wrote it: same version, no `diffstats`.
    const file = join(dir, `${run.runId}.json`);
    const old = JSON.parse(readFileSync(file, "utf8")) as {
      tasks: Array<{ result?: Record<string, unknown> }>;
    };
    for (const task of old.tasks) delete task.result?.diffstats;
    writeFileSync(file, JSON.stringify(old), "utf8");

    const saved = new FusionRunStore({ dir, probe: deadProbe }).load(run.runId);
    expect(saved).not.toBeNull();
    const plan = planResume(saved!);
    expect(plan.carried.map((r) => r.id)).toEqual(["t1"]);
    expect(plan.carried[0]).not.toHaveProperty("diffstats");
    expect(sumDiffStats(plan.carried)).toEqual([]);
  });

  it("drops damaged entries of a hand-edited checkpoint instead of failing the resume", () => {
    const run = start(new FusionRunStore({ dir, probe: deadProbe }));
    run.recordTask(row("t1", { diffstats: [{ path: "/repo/a.ts", added: 1, removed: 1 }] }));
    run.finish("interrupted");
    const file = join(dir, `${run.runId}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      tasks: Array<{ id: string; result?: Record<string, unknown> }>;
    };
    raw.tasks[0]!.result!.diffstats = [
      { path: "/repo/a.ts", added: 1, removed: 1 },
      { path: "", added: 1, removed: 0 },
      { path: "/repo/c.ts", added: -2, removed: 0 },
      "nonsense",
      null,
    ];
    writeFileSync(file, JSON.stringify(raw), "utf8");
    const plan = planResume(new FusionRunStore({ dir, probe: deadProbe }).load(run.runId)!);
    expect(plan.carried[0]!.diffstats).toEqual([{ path: "/repo/a.ts", added: 1, removed: 1 }]);
  });
});
