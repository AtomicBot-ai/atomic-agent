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
    s = reduceFusionLiveWorkers(
      s,
      ev({ taskId: "t1", phase: "tool", tool: "os.fs.read" }),
    );
    expect(s.map((w) => w.taskId)).toEqual(["t1", "t2"]);
    expect(s[0]?.tool).toBe("os.fs.read");
  });

  it("carries the model forward when a later event omits it", () => {
    let s = reduceFusionLiveWorkers([], ev());
    s = reduceFusionLiveWorkers(
      s,
      ev({ phase: "tool", tool: "os.fs.read", model: undefined }),
    );
    expect(s[0]?.model).toBe("qwen-3.5-4b");
  });

  it("marks a finished leg done and drops its tool, without removing it", () => {
    let s = reduceFusionLiveWorkers(
      [],
      ev({ phase: "tool", tool: "os.fs.read" }),
    );
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }));
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ done: true, tool: null });
  });

  it.each(["failed", "cancelled"])("treats %s as done too", (phase) => {
    const s = reduceFusionLiveWorkers([], ev({ phase }));
    expect(s[0]?.done).toBe(true);
  });

  it("ignores the orchestrator's own bracket lines", () => {
    expect(
      reduceFusionLiveWorkers([], ev({ role: "orchestrator" })),
    ).toHaveLength(0);
  });

  it("names the model and what the leg is doing", () => {
    expect(
      formatFusionLiveWorker(
        {
          taskId: "t1",
          title: "worker 1",
          model: "qwen-3.5-4b",
          tool: "os.fs.read",
          done: false,
          startedAt: 1_000,
          finishedAt: null,
          etaSeconds: null,
        },
        43_000,
      ),
    ).toBe("worker 1 · qwen-3.5-4b — os.fs.read · 42s");
  });

  it("never invents a model name, and says `working` between calls", () => {
    expect(
      formatFusionLiveWorker(
        {
          taskId: "t1",
          title: "worker 1",
          model: null,
          tool: null,
          done: false,
          startedAt: 1_000,
          finishedAt: null,
          etaSeconds: null,
        },
        1_000,
      ),
    ).toBe("worker 1 · local — working · 0s");
  });

  it("shows the orchestrator's estimate beside the running clock", () => {
    // `42s` alone cannot be read as fast or slow, which is the only
    // question this row is ever asked.
    let s = reduceFusionLiveWorkers([], ev({ etaSeconds: 120 }), 1_000);
    expect(formatFusionLiveWorker(s[0]!, 43_000)).toBe(
      "worker 1 · qwen-3.5-4b — working · 42s (~2m00s expected)",
    );
    // It arrives on the first event and is not repeated on every one.
    s = reduceFusionLiveWorkers(s, ev({ tool: "os.fs.read" }), 50_000);
    expect(s[0]?.etaSeconds).toBe(120);
  });

  it("drops the estimate once the leg is done", () => {
    // Then the elapsed time IS the answer, and a guess printed beside a
    // fact only invites the reader to check the guess.
    let s = reduceFusionLiveWorkers([], ev({ etaSeconds: 120 }), 1_000);
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }), 31_000);
    expect(formatFusionLiveWorker(s[0]!, 99_000)).toBe(
      "worker 1 · qwen-3.5-4b — done · 30s",
    );
  });

  it("starts a leg's clock at first sight and keeps it across tool calls", () => {
    // The elapsed time must not restart every time the worker changes
    // tool, or the readout always says a few seconds and the straggler
    // this feature exists to expose never looks slow.
    let s = reduceFusionLiveWorkers([], ev(), 1_000);
    s = reduceFusionLiveWorkers(s, ev({ tool: "os.fs.read" }), 20_000);
    s = reduceFusionLiveWorkers(s, ev({ tool: "os.shell.run" }), 50_000);
    expect(s[0]?.startedAt).toBe(1_000);
    expect(s[0]?.finishedAt).toBeNull();
    expect(formatFusionLiveWorker(s[0]!, 91_000)).toContain("1m30s");
  });

  it("stops the clock when the leg ends, and keeps it stopped", () => {
    let s = reduceFusionLiveWorkers([], ev(), 1_000);
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }), 31_000);
    expect(s[0]?.finishedAt).toBe(31_000);
    // Reading the row a minute later still reports what it took, not
    // how long ago it was.
    expect(formatFusionLiveWorker(s[0]!, 300_000)).toBe(
      "worker 1 · qwen-3.5-4b — done · 30s",
    );
    // A late duplicate event for a finished leg does not restart it.
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }), 90_000);
    expect(s[0]?.finishedAt).toBe(31_000);
  });
});
