import { describe, expect, it, vi } from "vitest";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import {
  FUSION_WORKER_ID_PREFIX,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  runWorkerTasks,
  WORKER_TOOL_LINES_PER_TASK,
  type WorkerRunnerDeps,
} from "./worker-runner.js";

type RunTurnCall = {
  session: SessionState;
  userMessage: string;
  options: Parameters<WorkerRunnerDeps["runTurn"]>[2];
};

function tasks(n: number): DelegateTask[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    instructions: `Do part ${i}`,
  }));
}

function harness(
  runTurn: (call: RunTurnCall) => Promise<RunTurnResult>,
): {
  deps: WorkerRunnerDeps;
  calls: RunTurnCall[];
  policies: Array<{ op: "set" | "clear"; sessionId: string }>;
  events: Array<{ sessionId: string; event: AgentLoopEvent }>;
} {
  const calls: RunTurnCall[] = [];
  const policies: Array<{ op: "set" | "clear"; sessionId: string }> = [];
  const events: Array<{ sessionId: string; event: AgentLoopEvent }> = [];
  let minted = 0;
  const deps: WorkerRunnerDeps = {
    runTurn: (session, userMessage, options) => {
      const call = { session, userMessage, options };
      calls.push(call);
      return runTurn(call);
    },
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: {
      setSessionPolicy: (sessionId) => policies.push({ op: "set", sessionId }),
      clearSessionPolicy: (sessionId) => policies.push({ op: "clear", sessionId }),
    },
    emitEvent: (sessionId, event) => events.push({ sessionId, event }),
    workingDir: "/repo",
  };
  return { deps, calls, policies, events };
}

function turnResult(over: Partial<RunTurnResult> = {}): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 1,
    ...over,
  };
}

const BASE = {
  parentSessionId: "s-parent",
  providerId: "local-llama",
  workerModel: "qwen-3.5-4b",
  workerMaxSteps: 7,
  workerTimeoutMs: 60_000,
};

describe("runWorkerTasks", () => {
  it("pins each worker turn to the local leg with the fusion origin and the worker filter", async () => {
    const { deps, calls } = harness(async ({ options }) => {
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
      return turnResult({ stepCount: 3 });
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({
      origin: "fusion",
      providerId: "local-llama",
      maxSteps: 7,
      taskMaxDurationMs: 60_000,
    });
    // The catalog narrowing is the policy module's, not a local copy.
    expect(calls[0]!.options.toolFilter?.("fusion.delegate")).toBe(false);
    expect(calls[0]!.options.toolFilter?.("os.fs.read")).toBe(true);
    expect(calls[0]!.userMessage).toContain("Do part 0");
    expect(results[0]).toMatchObject({ id: "t0", status: "ok", reply: "done", stepCount: 3 });
  });

  it("runs on a fresh session id, never the parent's — that would deadlock", async () => {
    const { deps, calls } = harness(async () => turnResult());
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(2),
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    const ids = calls.map((c) => c.session.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).not.toBe("s-parent");
      expect(id.startsWith(FUSION_WORKER_ID_PREFIX)).toBe(true);
    }
  });

  it("refuses approvals for the worker session and always clears the policy", async () => {
    const { deps, policies } = harness(async () => {
      throw new Error("provider exploded");
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "failed", error: "provider exploded" });
    // A policy left behind outlives the session it was keyed to: it is a
    // leak the gate never garbage-collects, so `finally` owns the clear.
    expect(policies.map((p) => p.op)).toEqual(["set", "clear"]);
    expect(policies[0]!.sessionId).toBe(policies[1]!.sessionId);
  });

  it("never exceeds maxWorkers concurrently, and keeps the pool saturated", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const { deps } = harness(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
      return turnResult();
    });
    const done = runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(6),
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    // Drain by releasing one at a time; a runner that finished must pick
    // the next unstarted task up immediately.
    for (let i = 0; i < 6; i += 1) {
      await vi.waitFor(() => expect(release.length).toBeGreaterThan(i));
      release[i]!();
    }
    const results = await done;
    expect(results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
  });

  it("returns results in task order regardless of completion order", async () => {
    const { deps } = harness(async ({ session }) => {
      // Later workers finish first.
      const delay = session.id.endsWith("1") ? 20 : 0;
      await new Promise((r) => setTimeout(r, delay));
      return turnResult();
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(3),
      maxWorkers: 3,
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.id)).toEqual(["t0", "t1", "t2"]);
  });

  it("reports cancelled — not failed — when the orchestrator's turn is aborted", async () => {
    const controller = new AbortController();
    const { deps } = harness(async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: controller.signal,
    });
    expect(results[0]!.status).toBe("cancelled");
  });

  it("emits started and finished into the PARENT session's frame", async () => {
    // `started` is raised from inside the worker's own event hook, which
    // the runtime calls under the worker's async context. Tagging the
    // event with the parent id is what makes it reach a recorder, a hook
    // and a UI at all — the worker session has none of the three.
    const { deps, events } = harness(async ({ options }) => {
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      expect(events.map((e) => e.event.type)).toEqual(["fusion_worker"]);
      options.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "the answer  is\nhere" },
      });
      return turnResult({ stepCount: 4 });
    });
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(events.map((e) => e.sessionId)).toEqual(["s-parent", "s-parent"]);
    expect(events[0]!.event).toMatchObject({
      type: "fusion_worker",
      taskId: "t0",
      title: "Task 0",
      phase: "started",
    });
    expect(events[1]!.event).toMatchObject({
      type: "fusion_worker",
      phase: "finished",
      stepCount: 4,
      summary: "the answer is here",
    });
  });

  it("announces each tool a worker starts, named with the worker's model", async () => {
    // A worker's own tool calls never reach the parent's UI (the TUI
    // reducer drops events whose session id is not the visible one), so
    // without this the operator can see that three workers are running
    // and nothing at all about what they are doing.
    const { deps, events } = harness(async ({ options }) => {
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      for (const tool of ["os.fs.read", "os.fs.grep", "reply"]) {
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_parsed",
            call: { tool, args: {} },
            batchIndex: 0,
            batchSize: 1,
          },
        });
      }
      return turnResult({ stepCount: 3 });
    });
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(events.map((e) => e.sessionId)).toEqual(Array(4).fill("s-parent"));
    expect(
      events.map((e) =>
        e.event.type === "fusion_worker"
          ? [e.event.phase, e.event.role, e.event.model, e.event.tool ?? null]
          : null,
      ),
    ).toEqual([
      ["started", "worker", "qwen-3.5-4b", null],
      ["tool", "worker", "qwen-3.5-4b", "os.fs.read"],
      ["tool", "worker", "qwen-3.5-4b", "os.fs.grep"],
      // `reply` ends the turn, it is not work the operator waits on —
      // the `done` line below is what reports it.
      ["finished", "worker", "qwen-3.5-4b", null],
    ]);
  });

  it("bounds the tool lines: consecutive repeats collapse and the count is capped", async () => {
    // Eight workers times a dozen tools each is a feed that shows
    // nothing else. The complete tally still comes back on the result
    // row, so the feed only owes the operator "who is doing what now".
    const { deps, events } = harness(async ({ options }) => {
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      const emit = (tool: string): void =>
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_parsed",
            call: { tool, args: {} },
            batchIndex: 0,
            batchSize: 1,
          },
        });
      // Ten identical greps are one fact, not ten lines…
      for (let i = 0; i < 10; i += 1) emit("os.fs.grep");
      // …and past the cap the feed goes quiet rather than scrolling.
      for (const tool of ["a", "b", "c", "d", "e", "f", "g"]) emit(tool);
      return turnResult({ stepCount: 17 });
    });
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    const toolLines = events.flatMap(({ event }) =>
      event.type === "fusion_worker" && event.phase === "tool"
        ? [event.tool]
        : [],
    );
    expect(toolLines).toHaveLength(WORKER_TOOL_LINES_PER_TASK);
    expect(toolLines).toEqual(["os.fs.grep", "a", "b", "c", "d"]);
  });

  it("emits the failed and cancelled phases for the outcomes that earn them", async () => {
    const { deps, events } = harness(async () => turnResult({ reason: "failed" }));
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(events[1]!.event).toMatchObject({ phase: "failed" });

    const cancelled = harness(async () => turnResult({ reason: "cancelled" }));
    await runWorkerTasks(cancelled.deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(cancelled.events[1]!.event).toMatchObject({ phase: "cancelled" });
  });

  it("pairs started with the terminal line even when the turn never stepped", async () => {
    // A turn that died before the hook ever fired would otherwise leave
    // a bare `failed` line about a worker the operator never saw start.
    const { deps, events } = harness(async () => {
      throw new Error("rejected before running");
    });
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(
      events.map((e) => (e.event.type === "fusion_worker" ? e.event.phase : e.event.type)),
    ).toEqual(["started", "failed"]);
  });

  it("keeps a sibling's result when one worker throws", async () => {
    const { deps } = harness(async ({ session }) => {
      if (session.id.endsWith("1")) throw new Error("first one died");
      return turnResult();
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(2),
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.status)).toEqual(["failed", "ok"]);
  });
});
