import { describe, expect, it } from "vitest";
import { FIT_TASK_SET_KIND, FIT_TASK_SET_VERSION, type FitTask, type FitTaskSet } from "./fit-task.js";
import type { FitTestDeps, LoadedFitModel } from "./fit-test-types.js";
import { runFitTest } from "./run-fit-test.js";

function task(id: string): FitTask {
  return {
    id,
    name: id,
    category: "os",
    prompt: `do ${id}`,
    expectations: [{ kind: "judge", rubric: "r" }],
    source: { sessionId: "s", at: 1, toolsUsed: [], referenceReply: "ok" },
  };
}

const SET: FitTaskSet = {
  kind: FIT_TASK_SET_KIND,
  version: FIT_TASK_SET_VERSION,
  createdAt: "2026-11-12T00:00:00.000Z",
  tasks: [task("a"), task("b")],
};

function fakeDeps(log: string[], overrides: Partial<FitTestDeps> = {}): FitTestDeps {
  let clock = 0;
  return {
    now: () => (clock += 100),
    loadModel: async (id) => {
      log.push(`load ${id}`);
      const model: LoadedFitModel = { url: `http://m/${id}`, apiKey: null, pid: id === "big" ? 2 : 1, release: async () => void log.push(`release ${id}`) };
      return model;
    },
    runTask: async (t, model) => {
      log.push(`run ${t.id} on ${model.url}`);
      return { reply: `reply ${t.id}`, durationMs: 1000, tokens: 50, timedOut: false, error: null };
    },
    judge: async (t) => ({ score: t.id === "a" ? 5 : 3, reason: "fine" }),
    sampleMemory: async (pid) => (pid === 2 ? 8_000_000_000 : 2_000_000_000),
    sampleEveryMs: 5,
    ...overrides,
  };
}

describe("runFitTest", () => {
  it("loads, runs and releases one model at a time, in order", async () => {
    const log: string[] = [];
    const run = await runFitTest(SET, ["small", "big"], fakeDeps(log), { createdAt: "x", gpuBudgetGb: 12 });
    expect(log).toEqual([
      "load small",
      "run a on http://m/small",
      "run b on http://m/small",
      "release small",
      "load big",
      "run a on http://m/big",
      "run b on http://m/big",
      "release big",
    ]);
    expect(run.taskIds).toEqual(["a", "b"]);
    expect(run.gpuBudgetGb).toBe(12);
    expect(run.models.map((m) => m.peakMemoryBytes)).toEqual([2_000_000_000, 8_000_000_000]);
    expect(run.models[0]!.tasks.map((t) => t.score)).toEqual([5, 3]);
    expect(run.models[0]!.loadMs).toBe(100);
  });

  it("records a model that fails to load and goes on", async () => {
    const log: string[] = [];
    const deps = fakeDeps(log);
    const load = deps.loadModel;
    deps.loadModel = async (id) => (id === "broken" ? Promise.reject(new Error("not downloaded")) : load(id));
    const run = await runFitTest(SET, ["broken", "small"], deps);
    expect(run.models[0]).toMatchObject({ modelId: "broken", loadError: "not downloaded", tasks: [] });
    expect(run.models[1]!.tasks).toHaveLength(2);
  });

  it("scores a crashed run or a failed judge as null and keeps going", async () => {
    const log: string[] = [];
    const run = await runFitTest(
      SET,
      ["small"],
      fakeDeps(log, {
        runTask: async (t) =>
          t.id === "a"
            ? { reply: "", durationMs: 10, tokens: null, timedOut: false, error: "agent exited 1" }
            : { reply: "r", durationMs: 10, tokens: null, timedOut: false, error: null },
        judge: async () => Promise.reject(new Error("HTTP 500")),
      }),
    );
    expect(run.models[0]!.tasks.map((t) => [t.score, t.reason])).toEqual([
      [null, "agent exited 1"],
      [null, "judge failed: HTTP 500"],
    ]);
    expect(log).toContain("release small");
  });
});
