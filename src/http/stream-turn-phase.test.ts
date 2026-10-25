import { describe, expect, it } from "vitest";

import type { AgentLoopEvent } from "../agent/agent-contract.js";
import { createTurnPhaseTracker, SLOW_FIRST_TOKEN_MS } from "./stream-turn-phase.js";
import type { SlowFirstTokenHint } from "./slow-first-token-hint.js";

/**
 * ATO-1027. A local model's first message showed nothing for minutes and
 * a third of those turns were stopped. The tracker turns the loop's own
 * events into `turn_phase` frames and, once, a `slow_first_token` hint.
 */
function harness(options: { hint?: SlowFirstTokenHint | null; slowMs?: number | null } = {}) {
  let clock = 1_000;
  const written: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const tracker = createTurnPhaseTracker({
    sessionId: "s1",
    write: (name, payload) => written.push({ name, payload }),
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    ...(options.slowMs !== undefined ? { slowFirstTokenMs: options.slowMs } : {}),
    ...(options.hint !== undefined ? { slowFirstTokenHint: () => options.hint ?? null } : {}),
  });
  return {
    tracker,
    written,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    phases: () => written.filter((w) => w.name === "turn_phase").map((w) => w.payload.phase),
    fire: () => {
      for (const t of timers) if (!t.cancelled) t.fn();
    },
  };
}

const step = (event: Extract<AgentLoopEvent, { type: "llm_event" }>["event"]): AgentLoopEvent => ({
  type: "llm_event",
  event,
});

const HINT: SlowFirstTokenHint = {
  modelId: "qwen-3.6-27b",
  lighterModel: { id: "qwen-3.5-9b", name: "Qwen 3.5 9B", fileSizeGb: 5.3, downloaded: false },
  cloudAvailable: true,
};

describe("turn_phase frames", () => {
  it("walks a local turn from start to a tool and back", () => {
    const h = harness();
    h.tracker.start();
    h.advance(10);
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    h.tracker.onEvent(step({ type: "reasoning_delta", stepIndex: 0, text: "plan" }));
    h.tracker.onEvent(step({ type: "first_token", stepIndex: 0 }));
    h.tracker.onEvent(step({ type: "reasoning_delta", stepIndex: 0, text: " more" }));
    h.tracker.onEvent(step({ type: "tool_call_parsed", call: { tool: "os.shell.run", args: {} }, batchIndex: 0, batchSize: 1 } as never));
    h.tracker.onEvent(step({ type: "tool_call_executed", result: { tool: "os.shell.run" }, batchIndex: 0, batchSize: 1 } as never));
    h.tracker.onEvent({ type: "step_started", stepIndex: 1 });
    h.tracker.onEvent(step({ type: "first_token", stepIndex: 1 }));
    h.tracker.onEvent(step({ type: "assistant_delta", text: "done" }));
    expect(h.phases()).toEqual([
      "starting",
      "processing_prompt",
      "thinking",
      "running_tool",
      "processing_prompt",
      "generating",
    ]);
    const tool = h.written.find((w) => w.payload.phase === "running_tool");
    expect(tool?.payload).toMatchObject({ object: "atomic.turn_phase", session_id: "s1", tool: "os.shell.run" });
    expect(h.written[1]?.payload).toMatchObject({ step_index: 0, phase_elapsed_ms: 0, turn_elapsed_ms: 10 });
  });

  it("says the model is loading, then the prompt's progress", () => {
    const h = harness();
    h.tracker.start();
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    h.tracker.onEvent({
      type: "provider_waiting", attempt: 1, waitedMs: 0, maxWaitMs: 300_000, nextRetryMs: 2_000,
      reason: "Loading model", cause: { kind: "loading" },
    });
    h.tracker.onEvent({
      type: "provider_waiting", attempt: 2, waitedMs: 2_000, maxWaitMs: 300_000, nextRetryMs: 4_000,
      reason: "Loading model", cause: { kind: "loading" },
    });
    h.advance(34_000);
    h.tracker.onEvent({ type: "provider_recovered", waitedMs: 34_000 });
    h.tracker.onEvent(step({ type: "prompt_progress", stepIndex: 0, processed: 512, total: 2048, cached: 0, elapsedMs: 900 }));
    h.tracker.onEvent(step({ type: "prompt_progress", stepIndex: 0, processed: 512, total: 2048, cached: 0, elapsedMs: 950 }));
    h.advance(1_000);
    h.tracker.onEvent(step({ type: "prompt_progress", stepIndex: 0, processed: 2048, total: 2048, cached: 0, elapsedMs: 1900 }));
    expect(h.phases()).toEqual([
      "starting",
      "processing_prompt",
      "loading_model",
      "processing_prompt",
      "processing_prompt",
      "processing_prompt",
    ]);
    const last = h.written.at(-1)?.payload;
    expect(last).toMatchObject({
      phase: "processing_prompt",
      phase_elapsed_ms: 1_000,
      progress: { processed: 2048, total: 2048, cached: 0, fraction: 1 },
    });
    expect(h.written.at(-2)?.payload).toMatchObject({ progress: { fraction: 0.25 } });
  });

  it("calls any other wait a provider wait, and names compaction", () => {
    const h = harness();
    h.tracker.start();
    h.tracker.onEvent({
      type: "provider_waiting", attempt: 1, waitedMs: 0, maxWaitMs: 1, nextRetryMs: 1, reason: "fetch failed",
    });
    h.tracker.onEvent({ type: "compaction_started", sessionId: "other", reason: "threshold", tokensBefore: 1 } as never);
    h.tracker.onEvent({ type: "compaction_started", sessionId: "s1", reason: "threshold", tokensBefore: 1 } as never);
    h.tracker.onEvent({ type: "compaction_completed", sessionId: "s1", result: { status: "compacted" } } as never);
    expect(h.phases()).toEqual(["starting", "waiting_provider", "compacting", "processing_prompt"]);
  });

  it("names the call that runs in a batch, and the reply as the answer", () => {
    const h = harness();
    h.tracker.start();
    const parsed = (tool: string, batchIndex: number) =>
      step({ type: "tool_call_parsed", call: { tool, args: {} }, batchIndex, batchSize: 3 } as never);
    const executed = (tool: string, batchIndex: number) =>
      step({ type: "tool_call_executed", result: { tool }, batchIndex, batchSize: 3 } as never);
    h.tracker.onEvent(parsed("os.fs.read", 0));
    h.tracker.onEvent(parsed("os.shell.run", 1));
    h.tracker.onEvent(parsed("reply", 2));
    h.tracker.onEvent(executed("os.fs.read", 0));
    h.tracker.onEvent(executed("os.shell.run", 1));
    const tools = h.written.map((w) => [w.payload.phase, w.payload.tool]);
    expect(tools).toEqual([
      ["starting", undefined],
      ["running_tool", "os.fs.read"],
      ["running_tool", "os.shell.run"],
      ["generating", undefined],
    ]);
  });

  it("does not go back to reading the prompt after the final reply", () => {
    const h = harness();
    h.tracker.start();
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    h.tracker.onEvent(step({ type: "first_token", stepIndex: 0 }));
    h.tracker.onEvent(step({ type: "tool_call_parsed", call: { tool: "reply", args: {} }, batchIndex: 0, batchSize: 1 } as never));
    h.tracker.onEvent(step({ type: "tool_call_executed", result: { tool: "reply" }, batchIndex: 0, batchSize: 1 } as never));
    expect(h.phases()).toEqual(["starting", "processing_prompt", "generating"]);
    expect(h.phases().at(-1)).not.toBe("processing_prompt");
  });

  it("writes nothing before start or after dispose", () => {
    const h = harness();
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    expect(h.written).toEqual([]);
    h.tracker.start();
    h.tracker.dispose();
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    expect(h.phases()).toEqual(["starting"]);
  });
});

describe("slow_first_token", () => {
  it("fires once with the hint when nothing came back in time", () => {
    const h = harness({ hint: HINT });
    h.tracker.start();
    expect(h.timers.map((t) => t.ms)).toEqual([SLOW_FIRST_TOKEN_MS]);
    h.tracker.onEvent({ type: "step_started", stepIndex: 0 });
    h.advance(SLOW_FIRST_TOKEN_MS);
    h.fire();
    const hints = h.written.filter((w) => w.name === "slow_first_token");
    expect(hints).toEqual([
      {
        name: "slow_first_token",
        payload: {
          object: "atomic.slow_first_token",
          session_id: "s1",
          waited_ms: SLOW_FIRST_TOKEN_MS,
          phase: "processing_prompt",
          model_id: "qwen-3.6-27b",
          lighter_model: { id: "qwen-3.5-9b", name: "Qwen 3.5 9B", file_size_gb: 5.3, downloaded: false },
          cloud_available: true,
        },
      },
    ]);
  });

  it("is called off by the first output", () => {
    const h = harness({ hint: HINT });
    h.tracker.start();
    h.tracker.onEvent(step({ type: "first_token", stepIndex: 0 }));
    expect(h.timers[0]?.cancelled).toBe(true);
  });

  it("stays silent off a local model, when turned off, and after dispose", () => {
    const cloud = harness({ hint: null });
    cloud.tracker.start();
    cloud.fire();
    expect(cloud.written.some((w) => w.name === "slow_first_token")).toBe(false);

    const off = harness({ hint: HINT, slowMs: null });
    off.tracker.start();
    expect(off.timers).toEqual([]);

    const gone = harness({ hint: HINT });
    gone.tracker.start();
    gone.tracker.dispose();
    expect(gone.timers[0]?.cancelled).toBe(true);
  });

  it("leaves out a lighter model when there is none", () => {
    const h = harness({ hint: { modelId: null, lighterModel: null, cloudAvailable: false } });
    h.tracker.start();
    h.fire();
    const payload = h.written.find((w) => w.name === "slow_first_token")?.payload;
    expect(payload).not.toHaveProperty("lighter_model");
    expect(payload).not.toHaveProperty("model_id");
    expect(payload).toMatchObject({ cloud_available: false });
  });
});
