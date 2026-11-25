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
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

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
  it("divides output tokens by the time the model spent producing them", () => {
    // A 60 s task that spent 50 s in tool runs: 60 tokens in 10 s of
    // generation is 6 tok/s, not the 1 tok/s the task clock would say.
    const sample = workerSpeedSample(
      result({ durationMs: 60_000, generation: { tokens: 60, ms: 10_000 } }),
    );
    expect(sample).toEqual({ tokens: 60, ms: 10_000, tasks: 1 });
    expect(sampleTokensPerSecond(sample!)).toBe(6);
  });

  it("measures nothing without generation, without tokens, on too little of it, or on a task that did not end ok", () => {
    expect(workerSpeedSample(result())).toBeNull();
    expect(
      workerSpeedSample(result({ generation: { tokens: 0, ms: 5_000 } })),
    ).toBeNull();
    expect(
      workerSpeedSample(result({ generation: { tokens: 60, ms: 500 } })),
    ).toBeNull();
    for (const status of ["timeout", "failed", "cancelled", "max_steps"] as const) {
      expect(
        workerSpeedSample(
          result({ status, generation: { tokens: 60, ms: 10_000 } }),
        ),
      ).toBeNull();
    }
  });
});

describe("WorkerRunCollector generation time", () => {
  function completion(over: {
    completionTokens?: number;
    predictedMs?: number;
    predictedTokens?: number;
  }) {
    return {
      type: "llm_event",
      event: {
        type: "llm_completed",
        completion: {
          content: "",
          reasoningContent: "",
          stop: true,
          truncated: false,
          cacheHitTokens: 0,
          slotId: 0,
          modelId: null,
          timing: {
            promptMs: 0,
            predictedMs: over.predictedMs ?? 0,
            promptTokens: 0,
            predictedTokens: over.predictedTokens ?? 0,
          },
          ...(over.completionTokens === undefined
            ? {}
            : {
                usage: {
                  promptTokens: 100,
                  completionTokens: over.completionTokens,
                  totalTokens: 100 + over.completionTokens,
                },
              }),
        },
      },
    } as unknown as AgentLoopEvent;
  }
  const promptBuilt = {
    type: "llm_event",
    event: { type: "prompt_built", prompt: {}, slotId: 0 },
  } as unknown as AgentLoopEvent;
  const finish = (c: WorkerRunCollector) =>
    c.finish({
      id: "t",
      title: "t",
      reason: null,
      stepCount: 2,
      durationMs: 60_000,
    });

  it("sums the server's decode time per completion, leaving tool time out", () => {
    let clock = 0;
    const c = new WorkerRunCollector(() => clock);
    c.observe(promptBuilt);
    clock += 30_000; // prefill + decode wall time, decode stated below
    c.observe(completion({ predictedTokens: 40, predictedMs: 8_000 }));
    clock += 20_000; // a tool run: not generation
    c.observe(promptBuilt);
    clock += 5_000;
    c.observe(completion({ predictedTokens: 20, predictedMs: 2_000 }));
    expect(finish(c).generation).toEqual({ tokens: 60, ms: 10_000 });
  });

  it("falls back to the request's wall time when the provider states no decode time", () => {
    let clock = 0;
    const c = new WorkerRunCollector(() => clock);
    c.observe(promptBuilt);
    clock += 2_000;
    c.observe(completion({ completionTokens: 96 }));
    clock += 40_000; // tools
    expect(finish(c).generation).toEqual({ tokens: 96, ms: 2_000 });
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
      result: result({ generation: { tokens: 60, ms: 10_000 } }),
      task: undefined,
      leg: "local",
      model: "qwen",
      costUsd: null,
      at: 1,
    });
    expect(measured.tokensPerSecond).toBe(6);
    const unmeasured = outcomeRowFor({
      result: result(),
      task: undefined,
      leg: "local",
      model: "qwen",
      costUsd: null,
      at: 1,
    });
    expect(unmeasured).not.toHaveProperty("tokensPerSecond");
  });
});
