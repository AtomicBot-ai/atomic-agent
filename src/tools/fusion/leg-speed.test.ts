import { describe, expect, it } from "vitest";
import {
  addSpeedSample,
  legSpeeds,
  renderLegSpeedLine,
  sampleTokensPerSecond,
  workerSpeedSample,
} from "./leg-speed.js";
import { outcomeRowFor } from "./outcome-log.js";
import { FusionTurnBudget } from "./turn-budget.js";
import type { WorkerTaskResult } from "./worker-result.js";

function result(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "t1",
    status: "ok",
    reply: "done",
    stepCount: 3,
    durationMs: 10_000,
    tools: { calls: 1, errors: 0, writes: 1, byTool: {} },
    usage: { promptTokens: 1000, completionTokens: 60, totalTokens: 1060 },
    ...over,
  };
}

describe("workerSpeedSample", () => {
  it("divides output tokens by the time spent generating, queue wait excluded", () => {
    const sample = workerSpeedSample(
      result({ durationMs: 12_000, queueWaitMs: 2_000 }),
    );
    expect(sample).toEqual({ tokens: 60, ms: 10_000, tasks: 1 });
    expect(sampleTokensPerSecond(sample!)).toBe(6);
  });

  it("measures nothing without usage, without tokens, or on a too-short run", () => {
    expect(workerSpeedSample(result({ usage: undefined }))).toBeNull();
    expect(
      workerSpeedSample(
        result({ usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }),
      ),
    ).toBeNull();
    expect(
      workerSpeedSample(result({ durationMs: 1_500, queueWaitMs: 1_000 })),
    ).toBeNull();
  });
});

describe("leg averages", () => {
  it("two workers with known tokens and time give the token-weighted mean of their leg", () => {
    // 60 tokens in 10 s and 120 tokens in 20 s: 180 tokens / 30 s = 6 tok/s.
    let local = addSpeedSample(undefined, { tokens: 60, ms: 10_000, tasks: 1 });
    local = addSpeedSample(local, { tokens: 120, ms: 20_000, tasks: 1 });
    const speeds = legSpeeds(
      new Map([
        ["local qwen", local],
        ["cloud gpt-5-mini", { tokens: 960, ms: 20_000, tasks: 1 }],
      ]),
    );
    expect(speeds).toEqual([
      { label: "local qwen", tokensPerSecond: 6, tasks: 2 },
      { label: "cloud gpt-5-mini", tokensPerSecond: 48, tasks: 1 },
    ]);
    expect(renderLegSpeedLine(speeds)).toBe(
      "\n\nMeasured speed this turn: local qwen 6 tok/s (2 tasks), cloud gpt-5-mini 48 tok/s (1 task). Size the next tasks from these.",
    );
  });

  it("renders nothing when nothing was measured", () => {
    expect(renderLegSpeedLine([])).toBe("");
  });

  it("keeps one turn's speeds per session and starts over with the next turn", () => {
    const budget = new FusionTurnBudget(() => 0);
    budget.begin("s1");
    budget.noteSpeed("s1", "local qwen", { tokens: 61, ms: 10_000, tasks: 1 });
    expect(budget.speeds("s1")).toEqual([
      { label: "local qwen", tokensPerSecond: 6.1, tasks: 1 },
    ]);
    expect(budget.speeds("s2")).toEqual([]);
    budget.begin("s1");
    expect(budget.speeds("s1")).toEqual([]);
  });
});

describe("outcome log row", () => {
  it("carries the measured speed when there is one, and leaves it out otherwise", () => {
    const measured = outcomeRowFor({
      result: result({ durationMs: 12_000, queueWaitMs: 2_000 }),
      task: undefined,
      leg: "local",
      model: "qwen",
      costUsd: null,
      at: 1,
    });
    expect(measured.tokensPerSecond).toBe(6);
    const unmeasured = outcomeRowFor({
      result: result({ usage: undefined }),
      task: undefined,
      leg: "local",
      model: "qwen",
      costUsd: null,
      at: 1,
    });
    expect(unmeasured).not.toHaveProperty("tokensPerSecond");
  });
});
