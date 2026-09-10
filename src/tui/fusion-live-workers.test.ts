import { describe, expect, it } from "vitest";

import {
  formatFusionLiveWorker,
  reduceFusionLiveWorkers,
  type FusionLiveWorker,
} from "./fusion-live-workers.js";

const ev = (over: Record<string, unknown> = {}) =>
  ({
    type: "fusion_worker",
    taskId: "t1",
    title: "worker 1",
    phase: "started",
    model: "qwen-3.5-4b",
    ...over,
  }) as never;

describe("the live fan-out readout", () => {
  it("adds a leg when it starts and keeps first-sight order", () => {
    let s: readonly FusionLiveWorker[] = [];
    s = reduceFusionLiveWorkers(s, ev());
    s = reduceFusionLiveWorkers(s, ev({ taskId: "t2", title: "worker 2" }));
    s = reduceFusionLiveWorkers(s, ev({ taskId: "t1", phase: "tool", tool: "os.fs.read" }));
    expect(s.map((w) => w.taskId)).toEqual(["t1", "t2"]);
    expect(s[0]?.tool).toBe("os.fs.read");
  });

  it("carries the model forward when a later event omits it", () => {
    let s = reduceFusionLiveWorkers([], ev());
    s = reduceFusionLiveWorkers(s, ev({ phase: "tool", tool: "os.fs.read", model: undefined }));
    expect(s[0]?.model).toBe("qwen-3.5-4b");
  });

  it("marks a finished leg done and drops its tool, without removing it", () => {
    let s = reduceFusionLiveWorkers([], ev({ phase: "tool", tool: "os.fs.read" }));
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ done: true, tool: null });
  });

  it.each(["failed", "cancelled"])("treats %s as done too", (phase) => {
    const s = reduceFusionLiveWorkers([], ev({ phase }));
    expect(s[0]?.done).toBe(true);
  });

  it("ignores the orchestrator's own bracket lines", () => {
    expect(reduceFusionLiveWorkers([], ev({ role: "orchestrator" }))).toHaveLength(0);
  });

  it("names the model and what the leg is doing", () => {
    expect(
      formatFusionLiveWorker({
        taskId: "t1",
        title: "worker 1",
        model: "qwen-3.5-4b",
        tool: "os.fs.read",
        done: false,
      }),
    ).toBe("worker 1 · qwen-3.5-4b — os.fs.read");
  });

  it("never invents a model name, and says `working` between calls", () => {
    expect(
      formatFusionLiveWorker({
        taskId: "t1",
        title: "worker 1",
        model: null,
        tool: null,
        done: false,
      }),
    ).toBe("worker 1 · local — working");
  });
});
