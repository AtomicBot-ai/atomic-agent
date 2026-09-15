import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import {
  WORKER_HINT_CONTEXT,
  WORKER_HINT_SATURATED,
} from "./worker-result.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import {
  FUSION_WORKER_ID_PREFIX,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  estimateWorkerTimeoutMs,
  runWorkerTasks,
  WORKER_TIMEOUT_FLOOR_MS,
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

function harness(runTurn: (call: RunTurnCall) => Promise<RunTurnResult>): {
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
      clearSessionPolicy: (sessionId) =>
        policies.push({ op: "clear", sessionId }),
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
      options.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "done" },
      });
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
      // The role is the policy module's too: a worker builds.
      toolRole: "builder",
    });
    // The catalog narrowing is the policy module's, not a local copy.
    expect(calls[0]!.options.toolFilter?.("fusion.delegate")).toBe(false);
    expect(calls[0]!.options.toolFilter?.("os.fs.read")).toBe(true);
    expect(calls[0]!.userMessage).toContain("Do part 0");
    expect(results[0]).toMatchObject({
      id: "t0",
      status: "ok",
      reply: "done",
      stepCount: 3,
    });
  });

  it("passes the worker reasoning and output cap into the turn, only when set (F20)", async () => {
    const { deps, calls } = harness(async () => turnResult());
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      workerReasoning: "low",
      workerMaxOutputTokens: 12_000,
      signal: new AbortController().signal,
    });
    expect(calls[0]!.options).toMatchObject({
      reasoningEffort: "low",
      maxOutputTokens: 12_000,
    });
    const plain = harness(async () => turnResult());
    await runWorkerTasks(plain.deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(plain.calls[0]!.options).not.toHaveProperty("reasoningEffort");
    expect(plain.calls[0]!.options).not.toHaveProperty("maxOutputTokens");
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
    expect(results[0]).toMatchObject({
      status: "failed",
      error: "provider exploded",
    });
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
    const { deps, events } = harness(async () =>
      turnResult({ reason: "failed" }),
    );
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
      events.map((e) =>
        e.event.type === "fusion_worker" ? e.event.phase : e.event.type,
      ),
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

  it("quotes the parent turn's original request in every worker's brief", async () => {
    const { deps, calls } = harness(async () => turnResult());
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(2),
      maxWorkers: 2,
      originalRequest: "Build a snake game with a dark theme",
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.userMessage).toContain(
        "ORIGINAL REQUEST — context only; your task is below.",
      );
      expect(call.userMessage).toContain("Build a snake game with a dark theme");
    }
    expect(calls[0]!.userMessage).toContain("Do part 0");
    expect(calls[1]!.userMessage).toContain("Do part 1");
  });

  it("renders the fan-out's contract into every worker's brief", async () => {
    const { deps, calls } = harness(async () => turnResult());
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(2),
      maxWorkers: 2,
      contract: {
        owners: { "a.js": "t0", "b.js": "t1" },
        provides: [{ task: "t0", kind: "symbol", name: "A", in: "a.js" }],
        requires: [{ task: "t1", name: "A" }],
      },
      signal: new AbortController().signal,
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.userMessage).toContain("CONTRACT — the interface between the parts");
      expect(call.userMessage).toContain("- [t0] symbol A in a.js");
    }
    expect(calls[0]!.userMessage).toContain("You own: a.js");
    expect(calls[0]!.userMessage).toContain("You provide: symbol A in a.js");
    expect(calls[1]!.userMessage).toContain("You own: b.js");
    expect(calls[1]!.userMessage).toContain("You may rely on: A (symbol from t0 in a.js)");
  });

  it("reports max_steps, not ok, when the worker replied on its forced final step", async () => {
    const { deps } = harness(async ({ options }) => {
      options.eventHook?.({
        type: "llm_event",
        event: {
          type: "assistant_reply",
          text: "the step limit was reached before the file write could be executed",
        },
      });
      return turnResult({
        reason: "reply",
        stepCount: 7,
        stopCause: "step_ceiling",
      });
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "max_steps", stepCount: 7 });
    expect(results[0]!.notes?.[0]).toMatch(/step limit \(7 steps\)/);
  });

  it("reports the worker's own time limit as max_steps, not as a cancellation", async () => {
    const { deps } = harness(
      ({ options }) =>
        new Promise<RunTurnResult>((resolve) => {
          options.signal!.addEventListener(
            "abort",
            () => resolve(turnResult({ reason: "cancelled", stepCount: 2 })),
            { once: true },
          );
        }),
    );
    const results = await runWorkerTasks(deps, {
      ...BASE,
      workerTimeoutMs: 30,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({ status: "max_steps", stepCount: 2 });
    expect(results[0]!.notes?.[0]).toMatch(/time limit/);
  });

  it("fails an ok task whose declared file does not exist, and notes untouched inputs", async () => {
    // Three times a worker replied "Implemented `js/scene.js`" — once
    // with invented tool results — and the file was not on disk.
    const dir = mkdtempSync(join(tmpdir(), "fusion-runner-files-"));
    try {
      writeFileSync(join(dir, "spec.md"), "the spec");
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "spec.md"), past, past);
      const { deps, events } = harness(async ({ options }) => {
        writeFileSync(join(dir, "index.html"), "<html></html>");
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "assistant_reply",
            text: "Implemented `js/scene.js` and index.html",
          },
        });
        return turnResult({ stepCount: 5 });
      });
      deps.workingDir = dir;
      const results = await runWorkerTasks(deps, {
        ...BASE,
        tasks: [
          {
            id: "t0",
            title: "Scene",
            instructions: "Write the scene",
            files: ["index.html", "js/scene.js", "spec.md", "js/**/*.js"],
          },
        ],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      expect(results[0]).toMatchObject({
        status: "failed",
        error: "declared file js/scene.js does not exist after the task",
        notes: ["spec.md unchanged by this task"],
      });
      expect(events.at(-1)!.event).toMatchObject({
        type: "fusion_worker",
        phase: "failed",
        summary: "declared file js/scene.js does not exist after the task",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no_changes for an ok task that declared files, wrote nothing and changed nothing", async () => {
    // "js/main.js unchanged by this task / I'm done!" came back `ok`.
    const dir = mkdtempSync(join(tmpdir(), "fusion-runner-files-"));
    try {
      mkdirSync(join(dir, "js"));
      writeFileSync(join(dir, "js", "main.js"), "old");
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "js", "main.js"), past, past);
      const { deps, events } = harness(async ({ options }) => {
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: { tool: "os.fs.read", status: "ok", summary: "old", details: {}, truncated: false },
            batchIndex: 0,
            batchSize: 1,
          },
        });
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "I'm done!" },
        });
        return turnResult({ stepCount: 2 });
      });
      deps.workingDir = dir;
      const results = await runWorkerTasks(deps, {
        ...BASE,
        tasks: [
          { id: "t0", title: "Main", instructions: "Fix main", files: ["js/main.js"] },
        ],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      expect(results[0]).toMatchObject({
        status: "no_changes",
        reply: "I'm done!",
        tools: { writes: 0 },
        notes: [
          "js/main.js unchanged by this task",
          "no write, edit or patch call succeeded and no declared file changed",
        ],
      });
      expect(results[0]).not.toHaveProperty("error");
      expect(events.at(-1)!.event).toMatchObject({
        type: "fusion_worker",
        phase: "finished",
        summary: "no changes — I'm done!",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never reports no_changes for a task without declared files, or one whose write succeeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-runner-files-"));
    try {
      writeFileSync(join(dir, "notes.md"), "old");
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(dir, "notes.md"), past, past);
      const research = harness(async ({ options }) => {
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "the answer" },
        });
        return turnResult();
      });
      research.deps.workingDir = dir;
      const [plain] = await runWorkerTasks(research.deps, {
        ...BASE,
        tasks: [{ id: "t0", title: "Research", instructions: "Read and report" }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      expect(plain!.status).toBe("ok");

      // A successful write call is the evidence, even when the declared
      // path is a glob the disk check cannot stat.
      const wrote = harness(async ({ options }) => {
        options.eventHook?.({
          type: "llm_event",
          event: {
            type: "tool_call_executed",
            result: { tool: "os.fs.write", status: "ok", summary: "wrote", details: {}, truncated: false },
            batchIndex: 0,
            batchSize: 1,
          },
        });
        return turnResult();
      });
      wrote.deps.workingDir = dir;
      const [written] = await runWorkerTasks(wrote.deps, {
        ...BASE,
        tasks: [{ id: "t0", title: "Write", instructions: "x", files: ["js/**/*.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      expect(written).toMatchObject({ status: "ok", tools: { writes: 1 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an ok task ok when every declared file was written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fusion-runner-files-"));
    try {
      const { deps } = harness(async () => {
        writeFileSync(join(dir, "index.html"), "<html></html>");
        return turnResult({ stepCount: 2 });
      });
      deps.workingDir = dir;
      const results = await runWorkerTasks(deps, {
        ...BASE,
        tasks: [
          {
            id: "t0",
            title: "Page",
            instructions: "Write it",
            files: ["index.html"],
          },
        ],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      expect(results[0]!.status).toBe("ok");
      expect(results[0]).not.toHaveProperty("error");
      expect(results[0]).not.toHaveProperty("notes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the worker's provider failure and a remediation hint to the orchestrator", async () => {
    const { deps, events } = harness(async ({ options }) => {
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({
        type: "loop_failed",
        error: new Error(
          'llama-server HTTP 500: {"error":{"message":"Context size has been exceeded."}}',
        ),
        category: "transport",
      });
      return turnResult({ reason: "failed", stepCount: 0 });
    });
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({
      status: "failed",
      hint: WORKER_HINT_CONTEXT,
    });
    expect(results[0]!.error).toContain("Context size has been exceeded");
    const last = events.at(-1)!.event;
    expect(last).toMatchObject({ type: "fusion_worker", phase: "failed" });
    expect(last.type === "fusion_worker" ? last.summary : "").toContain(
      "Context size has been exceeded",
    );
  });

  it("falls back to the session's stored error when the hook saw no loop failure", async () => {
    const lastError =
      "llama-server accepted the request but sent no first token within 120000ms — it may still be evaluating the prompt";
    const { deps } = harness(async () =>
      turnResult({
        reason: "failed",
        stepCount: 0,
        session: {
          ...createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
          lastError,
        },
      }),
    );
    const results = await runWorkerTasks(deps, {
      ...BASE,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]).toMatchObject({
      status: "failed",
      error: lastError,
      hint: WORKER_HINT_SATURATED,
    });
  });
});

describe("worker limits from throughput (F19)", () => {
  it("estimateWorkerTimeoutMs sizes from the brief, the declared files and the measured speed", () => {
    const ceilingMs = 2_700_000;
    // No measurement (or a cloud leg): the ceiling, as before.
    expect(estimateWorkerTimeoutMs({ briefChars: 4000, declaredFiles: 2, tokensPerSecond: null, ceilingMs })).toBe(ceilingMs);
    expect(estimateWorkerTimeoutMs({ briefChars: 4000, declaredFiles: 2, tokensPerSecond: 0, ceilingMs })).toBe(ceilingMs);
    // (4000/4 + 2×2000) tokens / 10 tok/s × 3 = 1,500 s = 25 min.
    expect(estimateWorkerTimeoutMs({ briefChars: 4000, declaredFiles: 2, tokensPerSecond: 10, ceilingMs })).toBe(1_500_000);
    // Fast machine, small task: the 10-minute floor.
    expect(estimateWorkerTimeoutMs({ briefChars: 400, declaredFiles: 1, tokensPerSecond: 200, ceilingMs })).toBe(WORKER_TIMEOUT_FLOOR_MS);
    // Slow machine, big task: the ceiling.
    expect(estimateWorkerTimeoutMs({ briefChars: 16_000, declaredFiles: 8, tokensPerSecond: 3, ceilingMs })).toBe(ceilingMs);
    // A ceiling below the floor is the operator's pin: honoured as is.
    expect(estimateWorkerTimeoutMs({ briefChars: 400, declaredFiles: 1, tokensPerSecond: 200, ceilingMs: 60_000 })).toBe(60_000);
  });

  it("gives each worker turn its own estimated time limit on a measured local leg", async () => {
    const { deps, calls } = harness(async () => turnResult());
    const withFiles = { ...tasks(1)[0]!, files: ["a.js", "b.js"] };
    await runWorkerTasks(deps, {
      ...BASE,
      workerTimeoutMs: 2_700_000,
      localTokensPerSecond: 10,
      tasks: [withFiles],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    const briefChars = calls[0]!.userMessage.length;
    const expected = estimateWorkerTimeoutMs({
      briefChars,
      declaredFiles: 2,
      tokensPerSecond: 10,
      ceilingMs: 2_700_000,
    });
    expect(calls[0]!.options.taskMaxDurationMs).toBe(expected);
    expect(expected).toBeGreaterThanOrEqual(WORKER_TIMEOUT_FLOOR_MS);
    expect(expected).toBeLessThan(2_700_000);

    const unmeasured = harness(async () => turnResult());
    await runWorkerTasks(unmeasured.deps, {
      ...BASE,
      workerTimeoutMs: 2_700_000,
      localTokensPerSecond: null,
      tasks: [withFiles],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(unmeasured.calls[0]!.options.taskMaxDurationMs).toBe(2_700_000);
  });
});


describe("early hand-back when nothing is written (D4 / F19, F42)", () => {
  const stepStarted = (stepIndex: number): AgentLoopEvent => ({ type: "step_started", stepIndex });
  const stepFinished = (stepIndex: number): AgentLoopEvent => ({
    type: "step_finished",
    stepIndex,
    summary: "step done",
    durationMs: 1,
  });
  const wrote = (tool = "os.fs.write"): AgentLoopEvent => ({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool, status: "ok", summary: "wrote a.js", details: {}, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  });
  const read = (): AgentLoopEvent => ({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool: "os.fs.read", status: "ok", summary: "read main.js: 40 lines", details: {}, truncated: false },
      batchIndex: 0,
      batchSize: 1,
    },
  });
  const replied = (): AgentLoopEvent => ({
    type: "llm_event",
    event: { type: "assistant_reply", text: "done" },
  });
  type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

  /**
   * A worker that reads at every step and writes at `writeAtStep`, if
   * ever. Mirrors the loop's order: the signal is checked at the top of
   * a step, a step's tool result lands before its `step_finished`.
   */
  function stepping(writeAtStep: number | null) {
    return async ({ options }: { options: TurnOptions }) => {
      for (let step = 1; step <= 8; step += 1) {
        if (options.signal?.aborted) {
          return turnResult({ reason: "cancelled", stepCount: step - 1 });
        }
        options.eventHook?.(stepStarted(step - 1));
        options.eventHook?.(step === writeAtStep ? wrote() : read());
        options.eventHook?.(stepFinished(step - 1));
      }
      options.eventHook?.(replied());
      return turnResult({ stepCount: 8 });
    };
  }

  /**
   * A worker whose current step is one long generation: `completedBefore`
   * read-only steps finish at once, then the next step starts and its
   * completion stays in flight until the test releases it (it then
   * writes the file and replies) or the signal aborts — the two ways a
   * streaming request ends in the real loop.
   */
  function generating(completedBefore: number) {
    let release: (() => void) | undefined;
    const runTurn = ({ options }: { options: TurnOptions }) =>
      new Promise<RunTurnResult>((resolve) => {
        for (let i = 0; i < completedBefore; i += 1) {
          options.eventHook?.(stepStarted(i));
          options.eventHook?.(read());
          options.eventHook?.(stepFinished(i));
        }
        options.eventHook?.(stepStarted(completedBefore));
        options.signal?.addEventListener(
          "abort",
          () => resolve(turnResult({ reason: "cancelled", stepCount: completedBefore })),
          { once: true },
        );
        release = () => {
          options.eventHook?.(wrote());
          options.eventHook?.(stepFinished(completedBefore));
          options.eventHook?.(replied());
          resolve(turnResult({ stepCount: completedBefore + 1 }));
        };
      });
    return { runTurn, release: () => release!() };
  }

  it("hands a task with declared files back once half the steps pass with no write", async () => {
    const { deps, events } = harness(stepping(null));
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerMaxSteps: 8,
      tasks: [{ ...tasks(1)[0]!, files: ["a.js"] }],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(result!.status).toBe("needs_orchestrator");
    // Half of 8 is 4: the fifth step is the one that is not taken.
    expect(result!.reply).toMatch(/^handed back early: no file written by half the budget \(4 of 8 steps/);
    expect(result!.reply).toContain("what I found: 4 tool calls (os.fs.read×4)");
    expect(result!.reply).toContain("read main.js: 40 lines");
    expect(result!.stepCount).toBe(4);
    expect(result!.error).toBeUndefined();
    expect(result!.notes).toContainEqual(
      expect.stringContaining(
        "handed back early: declared files but wrote none by half the budget (4 steps completed, none a successful write)",
      ),
    );
    const finished = events.map((e) => e.event).find((e) => e.type === "fusion_worker" && e.phase !== "started" && e.phase !== "tool");
    expect(finished).toMatchObject({ phase: "finished", summary: "needs the orchestrator" });
  });

  it("lets a worker that wrote something before the half-way mark run on", async () => {
    // The declared file exists afterwards, so the ground-truth check
    // has nothing to downgrade and the status is the loop's own.
    const workingDir = mkdtempSync(join(tmpdir(), "atomic-handback-"));
    writeFileSync(join(workingDir, "a.js"), "ok\n");
    const { deps } = harness(stepping(3));
    deps.workingDir = workingDir;
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerMaxSteps: 8,
      tasks: [{ ...tasks(1)[0]!, files: ["a.js"] }],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(result!.status).toBe("ok");
    expect(result!.stepCount).toBe(8);
  });

  it("never hands back a task that declared no files", async () => {
    const { deps } = harness(stepping(null));
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerMaxSteps: 8,
      tasks: tasks(1),
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(result!.status).toBe("ok");
    expect(result!.stepCount).toBe(8);
  });

  it("hands back after two completed no-write steps, even when half the budget is one (F42)", async () => {
    // Half of 3 is 1, but one completed step is a worker that read the
    // spec: the floor holds the check until a second step has finished.
    const { deps } = harness(stepping(null));
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerMaxSteps: 3,
      tasks: [{ ...tasks(1)[0]!, files: ["a.js"] }],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(result!.status).toBe("needs_orchestrator");
    expect(result!.reply).toMatch(/^handed back early: no file written by half the budget \(2 of 3 steps/);
    expect(result!.stepCount).toBe(2);
    expect(result!.notes).toContainEqual(
      expect.stringContaining("(2 steps completed, none a successful write)"),
    );
  });

  it("never hands back on one completed step: a worker that reads once and then writes runs on (F42)", async () => {
    // Half of 2 is 1; F19 would have stopped this worker as it started
    // its second step — the write. A glob keeps the disk check out of
    // it, so the write call is the evidence.
    const { deps } = harness(stepping(2));
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerMaxSteps: 2,
      tasks: [{ ...tasks(1)[0]!, files: ["js/**/*.js"] }],
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    expect(result!).toMatchObject({ status: "ok", stepCount: 8, tools: { writes: 1 } });
  });

  it("keeps generating past half the time limit while the first completion is still streaming (F42)", async () => {
    // Live: a 6 tok/s worker was 1,350 s — half its limit — into its
    // FIRST completion, 7,293 tokens of the file it was about to write,
    // when F19's timer stopped it. Nothing has completed, nothing is
    // checked: the worker runs on and the write lands.
    vi.useFakeTimers();
    try {
      const worker = generating(0);
      const { deps, calls } = harness(worker.runTurn);
      let done = false;
      const run = runWorkerTasks(deps, {
        ...BASE,
        workerTimeoutMs: 60_000,
        tasks: [{ ...tasks(1)[0]!, files: ["js/**/*.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      }).then((results) => {
        done = true;
        return results;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls[0]!.options.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls[0]!.options.signal?.aborted).toBe(false);
      expect(done).toBe(false);
      worker.release();
      const [result] = await run;
      expect(result!).toMatchObject({ status: "ok", reply: "done", stepCount: 1, tools: { writes: 1 } });
      expect(result!.notes).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hand back a worker with one completed step and a long in-flight generation (F42)", async () => {
    // One read step done, the second step's completion streaming past
    // half the time limit: the floor is two completed steps, and a
    // check only runs at a step boundary anyway.
    vi.useFakeTimers();
    try {
      const worker = generating(1);
      const { deps, calls } = harness(worker.runTurn);
      let done = false;
      const run = runWorkerTasks(deps, {
        ...BASE,
        workerMaxSteps: 8,
        workerTimeoutMs: 60_000,
        tasks: [{ ...tasks(1)[0]!, files: ["js/**/*.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      }).then((results) => {
        done = true;
        return results;
      });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(calls[0]!.options.signal?.aborted).toBe(false);
      expect(done).toBe(false);
      worker.release();
      const [result] = await run;
      expect(result!).toMatchObject({ status: "ok", stepCount: 2, tools: { calls: 2, writes: 1 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back at a step boundary once two steps completed past half the time, not at one (F42)", async () => {
    vi.useFakeTimers();
    try {
      let abortedAfterFirst: boolean | undefined;
      const { deps } = harness(async ({ options }) => {
        // The first step's completion takes 31 s of a 60 s limit.
        options.eventHook?.(stepStarted(0));
        options.eventHook?.(read());
        await new Promise((r) => setTimeout(r, 31_000));
        options.eventHook?.(stepFinished(0));
        abortedAfterFirst = options.signal?.aborted;
        options.eventHook?.(stepStarted(1));
        options.eventHook?.(read());
        await new Promise((r) => setTimeout(r, 1_000));
        options.eventHook?.(stepFinished(1));
        if (options.signal?.aborted) {
          return turnResult({ reason: "cancelled", stepCount: 2 });
        }
        options.eventHook?.(replied());
        return turnResult({ stepCount: 2 });
      });
      const run = runWorkerTasks(deps, {
        ...BASE,
        workerMaxSteps: 8,
        workerTimeoutMs: 60_000,
        tasks: [{ ...tasks(1)[0]!, files: ["a.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(32_000);
      const [result] = await run;
      // One completed step past the half-way mark is not enough…
      expect(abortedAfterFirst).toBe(false);
      // …two are, and the check ran when the second finished.
      expect(result!.status).toBe("needs_orchestrator");
      expect(result!.reply).toMatch(/^handed back early: no file written by half the budget \(2 of 8 steps, 1 min of 1 min\)/);
      expect(result!.stepCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still ends a worker stuck in one endless step at its time limit (fake timers)", async () => {
    // The hand-back never fires mid-generation; the wall timeout is the
    // hard bound and does, exactly as before.
    vi.useFakeTimers();
    try {
      const worker = generating(0);
      const { deps, calls } = harness(worker.runTurn);
      let done = false;
      const run = runWorkerTasks(deps, {
        ...BASE,
        workerTimeoutMs: 60_000,
        tasks: [{ ...tasks(1)[0]!, files: ["a.js"] }],
        maxWorkers: 1,
        signal: new AbortController().signal,
      }).then((results) => {
        done = true;
        return results;
      });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(calls[0]!.options.signal?.aborted).toBe(false);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls[0]!.options.signal?.aborted).toBe(true);
      const [result] = await run;
      expect(result!).toMatchObject({ status: "max_steps", stepCount: 0 });
      expect(result!.notes?.[0]).toMatch(/time limit/);
      expect(result!.reply).not.toContain("handed back");
      expect(result!.durationMs).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
