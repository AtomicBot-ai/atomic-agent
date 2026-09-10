import { describe, expect, it } from "vitest";

import {
  formatFusionWorkerLine,
  fusionWorkerLineColor,
} from "./format-fusion-worker-line.js";

describe("formatFusionWorkerLine", () => {
  it("names the model running each worker leg", () => {
    // The operator's question during a fan-out is "which model is
    // spending right now": a line that only says `worker 2` answers it
    // for neither leg.
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "t2",
        title: "2",
        phase: "tool",
        role: "worker",
        model: "qwen-3.5-4b",
        tool: "os.fs.write",
      }),
    ).toBe("» worker 2 · qwen-3.5-4b — os.fs.write");
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "t2",
        title: "2",
        phase: "finished",
        role: "worker",
        model: "qwen-3.5-4b",
        stepCount: 4,
      }),
    ).toBe("» worker 2 · qwen-3.5-4b: done — 4 steps");
  });

  it("attributes the fan-out itself to the orchestrator's model", () => {
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "fusion.delegate",
        title: "3 tasks",
        phase: "tool",
        role: "orchestrator",
        model: "anthropic/claude-sonnet-4.5",
        tool: "fusion.delegate",
      }),
    ).toBe(
      "» orchestrator · anthropic/claude-sonnet-4.5 — fusion.delegate (3 tasks)",
    );
    // No step count of its own — the orchestrator is mid-turn here, not
    // finished, so the line carries the fan-out result instead.
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "fusion.delegate",
        title: "3 tasks",
        phase: "finished",
        role: "orchestrator",
        model: "anthropic/claude-sonnet-4.5",
        summary: "2/3 ok — merging",
      }),
    ).toBe(
      "» orchestrator · anthropic/claude-sonnet-4.5: done — 2/3 ok — merging",
    );
  });

  it("omits the model rather than inventing one", () => {
    // `workerModel` and `orchestratorModel` are both nullable in the
    // resolver. A placeholder here would be attribution the runtime
    // cannot stand behind.
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "t1",
        title: "A",
        phase: "started",
      }),
    ).toBe("» worker A: started");
    expect(
      formatFusionWorkerLine({
        type: "fusion_worker",
        taskId: "t1",
        title: "A",
        phase: "tool",
        tool: "os.fs.read",
      }),
    ).toBe("» worker A — os.fs.read");
  });

  it("keeps the original colour semantics", () => {
    const base = { type: "fusion_worker", taskId: "t", title: "A" } as const;
    expect(fusionWorkerLineColor({ ...base, phase: "started" })).toBe("gray");
    expect(fusionWorkerLineColor({ ...base, phase: "tool" })).toBe("gray");
    expect(fusionWorkerLineColor({ ...base, phase: "finished" })).toBe("green");
    expect(fusionWorkerLineColor({ ...base, phase: "failed" })).toBe("red");
    expect(fusionWorkerLineColor({ ...base, phase: "cancelled" })).toBe(
      "yellow",
    );
  });
});
