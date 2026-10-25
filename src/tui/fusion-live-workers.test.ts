import { describe, expect, it } from "vitest";

import {
  etaCorrection,
  fanoutExpectation,
  formatFusionLiveWorker,
  isFusionWorkerStuck,
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

  it("carries the context size a worker's completions report, and keeps it once done", () => {
    let s = reduceFusionLiveWorkers([], ev(), 1_000);
    expect(s[0]?.contextTokens).toBeNull();
    s = reduceFusionLiveWorkers(s, ev({ phase: "usage", contextTokens: 6_400 }));
    s = reduceFusionLiveWorkers(s, ev({ phase: "tool", tool: "os.fs.read" }));
    // A tool line does not repeat the count; the last measurement stands.
    expect(s[0]?.contextTokens).toBe(6_400);
    expect(s[0]?.tool).toBe("os.fs.read");
    // A usage update is not a phase change: the leg is still running.
    s = reduceFusionLiveWorkers(s, ev({ phase: "usage", contextTokens: 12_345 }));
    expect(s[0]).toMatchObject({ done: false, tool: "os.fs.read", contextTokens: 12_345 });
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }));
    expect(s[0]).toMatchObject({ done: true, contextTokens: 12_345 });
  });

  it("shows the context size last on the row, in the context chip's units", () => {
    let s = reduceFusionLiveWorkers([], ev({ etaSeconds: 120 }), 1_000);
    s = reduceFusionLiveWorkers(
      s,
      ev({ phase: "tool", tool: "os.fs.read" }),
      2_000,
    );
    s = reduceFusionLiveWorkers(
      s,
      ev({ phase: "usage", contextTokens: 12_345 }),
      3_000,
    );
    expect(formatFusionLiveWorker(s[0]!, 43_000)).toBe(
      "worker 1 · qwen-3.5-4b — os.fs.read · 42s (~2m00s expected) · 12.3k ctx",
    );
    s = reduceFusionLiveWorkers(s, ev({ phase: "finished" }), 61_000);
    expect(formatFusionLiveWorker(s[0]!, 99_000)).toBe(
      "worker 1 · qwen-3.5-4b — done · 1m00s · 12.3k ctx",
    );
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
          contextTokens: null,
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
          contextTokens: null,
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

describe("the estimate is corrected by what this fan-out actually did", () => {
  const leg = (
    over: Record<string, unknown> = {},
  ): Parameters<typeof etaCorrection>[0][number] => ({
    taskId: "t",
    title: "w",
    model: "qwen",
    tool: null,
    done: true,
    startedAt: 0,
    finishedAt: 600_000,
    etaSeconds: 120,
    contextTokens: null,
    ...over,
  });

  it("is the median ratio of finished legs, not the mean", () => {
    // One straggler at 20x must not drag every other row with it.
    const workers = [
      leg({ finishedAt: 120_000 }), // 1x
      leg({ finishedAt: 240_000 }), // 2x
      leg({ finishedAt: 2_400_000 }), // 20x
    ];
    expect(etaCorrection(workers)).toBe(2);
  });

  it("has no opinion until a leg has finished", () => {
    expect(etaCorrection([leg({ done: false, finishedAt: null })])).toBeNull();
    expect(etaCorrection([])).toBeNull();
  });

  it("ignores legs the orchestrator never estimated", () => {
    expect(etaCorrection([leg({ etaSeconds: null })])).toBeNull();
  });

  it("scales a running leg's expectation by the correction", () => {
    // The field shape: the cloud model said two minutes, the work took
    // nineteen. The next row should not still promise two.
    const running = {
      taskId: "t2",
      title: "worker 2",
      model: "qwen",
      tool: null,
      done: false,
      startedAt: 0,
      finishedAt: null,
      etaSeconds: 120,
      contextTokens: null,
    } as const;
    expect(formatFusionLiveWorker(running, 60_000, 5)).toContain(
      "(~10m00s expected)",
    );
  });

  it("says `past` instead of insisting on an estimate already blown", () => {
    const running = {
      taskId: "t2",
      title: "worker 2",
      model: "qwen",
      tool: null,
      done: false,
      startedAt: 0,
      finishedAt: null,
      etaSeconds: 120,
      contextTokens: null,
    } as const;
    expect(formatFusionLiveWorker(running, 19 * 60_000)).toContain(
      "past the ~2m00s expected",
    );
  });
});

describe("a leg the orchestrator never estimated", () => {
  const finished = {
    taskId: "t1",
    title: "worker 1",
    model: "qwen",
    tool: null,
    done: true,
    startedAt: 0,
    finishedAt: 840_000,
    etaSeconds: null,
    contextTokens: null,
  } as const;
  const running = {
    taskId: "t2",
    title: "worker 2",
    model: "qwen",
    tool: null,
    done: false,
    startedAt: 0,
    finishedAt: null,
    etaSeconds: null,
    contextTokens: null,
  } as const;

  it("is given the wave's own median instead of nothing", () => {
    // Measured in the field: every task of a real four-worker run came
    // back with `etaSeconds: null`, so the row had no expectation at
    // all. Its siblings' durations are a measurement, not a guess.
    expect(
      formatFusionLiveWorker(running, 60_000, fanoutExpectation([finished])),
    ).toContain("(~14m00s expected)");
  });

  it("says nothing until a sibling has finished", () => {
    const out = formatFusionLiveWorker(running, 60_000, fanoutExpectation([]));
    expect(out).toBe("worker 2 · qwen — working · 1m00s");
  });
});

describe("a leg that needs interrupting", () => {
  const running = (over: Record<string, unknown> = {}) =>
    ({
      taskId: "t1",
      title: "worker 1",
      model: "qwen-3.5-4b",
      tool: "os.fs.write",
      done: false,
      startedAt: 0,
      finishedAt: null,
      etaSeconds: 120,
      contextTokens: null,
      ...over,
    }) as FusionLiveWorker;

  it("is late one expectation in and not stuck yet", () => {
    expect(isFusionWorkerStuck(running(), 3 * 60_000)).toBe(false);
    expect(formatFusionLiveWorker(running(), 3 * 60_000)).toContain(
      "(past the ~2m00s expected)",
    );
    expect(formatFusionLiveWorker(running(), 3 * 60_000)).not.toContain(
      "stuck",
    );
  });

  it("is flagged once it passes twice its expectation", () => {
    // The field case from #542: a 2m estimate at nineteen minutes. The
    // reader should not have to do the comparison.
    expect(isFusionWorkerStuck(running(), 19 * 60_000)).toBe(true);
    const row = formatFusionLiveWorker(running(), 19 * 60_000);
    expect(row).toContain("stuck");
    // Still shows what it was expected to take, so the flag can be
    // judged rather than just obeyed.
    expect(row).toContain("past the ~2m00s expected");
  });

  it("judges against the corrected expectation, not the raw estimate", () => {
    // Correction 5 puts the expectation at ten minutes, so nineteen is
    // late but not stuck: the estimate was wrong, the leg is not.
    expect(isFusionWorkerStuck(running(), 19 * 60_000, 5)).toBe(false);
    expect(isFusionWorkerStuck(running(), 21 * 60_000, 5)).toBe(true);
  });

  it("uses the wave's median when the orchestrator estimated nothing", () => {
    const unestimated = running({ etaSeconds: null });
    const measured = fanoutExpectation([
      {
        ...unestimated,
        taskId: "t2",
        title: "worker 2",
        tool: null,
        done: true,
        finishedAt: 840_000,
      },
      {
        ...unestimated,
        taskId: "t3",
        title: "worker 3",
        tool: null,
        done: true,
        finishedAt: 900_000,
      },
    ]);
    expect(isFusionWorkerStuck(unestimated, 60_000, measured)).toBe(false);
    expect(isFusionWorkerStuck(unestimated, 29 * 60_000, measured)).toBe(true);
  });

  it("does not flag off a single finished sibling", () => {
    // The fan-out the flag would have got wrong: the orchestrator
    // estimated nothing, and the first leg out was a thirty-second
    // lookup. Twice thirty seconds is a minute, so without this floor
    // every remaining leg of the wave would have been told to cancel
    // itself.
    const unestimated = running({ etaSeconds: null });
    const fast = {
      ...unestimated,
      taskId: "t2",
      title: "worker 2",
      tool: null,
      done: true,
      finishedAt: 30_000,
    };
    const measured = fanoutExpectation([fast]);
    expect(isFusionWorkerStuck(unestimated, 29 * 60_000, measured)).toBe(false);
    expect(
      formatFusionLiveWorker(unestimated, 29 * 60_000, measured),
    ).not.toContain("stuck");
    // The row still shows what it is being compared against, so the
    // absence of the flag can be judged rather than just obeyed.
    expect(
      formatFusionLiveWorker(unestimated, 29 * 60_000, measured),
    ).toContain("past the ~30s expected");
    // A second sibling ends the doubt: the median is a median again.
    const twoSiblings = fanoutExpectation([
      fast,
      { ...fast, taskId: "t3", finishedAt: 14 * 60_000 },
    ]);
    expect(isFusionWorkerStuck(unestimated, 29 * 60_000, twoSiblings)).toBe(
      true,
    );
  });

  it("waits out the floor when a good estimate says sooner", () => {
    // A 1m estimate blown to 2m30s clears the multiple twice over, and
    // is still half a minute short of "go and cancel this".
    const quick = running({ etaSeconds: 60 });
    expect(isFusionWorkerStuck(quick, 150_000)).toBe(false);
    expect(formatFusionLiveWorker(quick, 150_000)).not.toContain("stuck");
    expect(formatFusionLiveWorker(quick, 150_000)).toContain(
      "past the ~1m00s expected",
    );
    expect(isFusionWorkerStuck(quick, 3 * 60_000)).toBe(true);
  });

  it("has no opinion with no expectation at all", () => {
    const unestimated = running({ etaSeconds: null });
    expect(isFusionWorkerStuck(unestimated, 60 * 60_000)).toBe(false);
    expect(
      isFusionWorkerStuck(unestimated, 60 * 60_000, fanoutExpectation([])),
    ).toBe(false);
  });

  it("is never stuck once the leg is done", () => {
    // Nineteen minutes well spent is a slow leg, not a stuck one.
    const finished = running({ done: true, finishedAt: 19 * 60_000 });
    expect(isFusionWorkerStuck(finished, 19 * 60_000)).toBe(false);
    expect(formatFusionLiveWorker(finished, 19 * 60_000)).not.toContain("stuck");
  });

  it("keeps the flag before the context count, which truncates first", () => {
    const row = formatFusionLiveWorker(
      running({ contextTokens: 123_456 }),
      19 * 60_000,
    );
    expect(row.indexOf("stuck")).toBeLessThan(row.indexOf("ctx"));
  });
});
