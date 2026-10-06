import { describe, it, expect, vi, afterEach } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import {
  LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS,
  LOCAL_WORKER_TASK_BUDGET_FLOOR_MS,
  QUEUE_SLOT_PROBE_TIMEOUT_MS,
  runWorkerTasks,
  type WorkerRunnerDeps,
} from "./worker-runner.js";
import {
  WORKER_HINT_IDLE_SERVER,
  WORKER_HINT_QUEUED,
  workerHintNoFirstToken,
} from "./worker-result.js";
import type { DelegateTask } from "./delegate-args.js";

const MIN = 60_000;
const WORKER_BUDGET = 45 * MIN;

function harness(
  runTurn: (
    options: Parameters<WorkerRunnerDeps["runTurn"]>[2],
  ) => Promise<RunTurnResult>,
): WorkerRunnerDeps {
  let minted = 0;
  return {
    runTurn: (_session: SessionState, _msg: string, options) =>
      runTurn(options),
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: "/repo",
  };
}

const TASK: DelegateTask[] = [
  { id: "t0", title: "Task 0", instructions: "Do the thing" },
];

const TWO_TASKS: DelegateTask[] = [
  { id: "t0", title: "Task 0", instructions: "one" },
  { id: "t1", title: "Task 1", instructions: "two" },
];

/** A turn the server never answers: it ends only when it is aborted. */
function neverAnswered(
  options: Parameters<WorkerRunnerDeps["runTurn"]>[2],
): Promise<RunTurnResult> {
  return new Promise<RunTurnResult>((resolve) => {
    options.signal?.addEventListener("abort", () =>
      resolve({
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: "cancelled",
        stepCount: 0,
      }),
    );
  });
}

const BASE = {
  parentSessionId: "s-parent",
  providerId: "local-llama",
  workerModel: "qwen-3.5-4b",
  workerMaxSteps: 7,
  workerTimeoutMs: WORKER_BUDGET,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the worker's clock does not run while it is queued", () => {
  /**
   * The field case: a 4-task fan-out on a 2-slot server. The tail
   * workers' requests sat in llama-server's queue, produced no token,
   * and were killed 45 minutes later reporting zero steps — because the
   * wall timer was armed before the server ever answered.
   */
  it("ends a never-served worker on the queue budget, not the whole budget", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let abortedAt: number | null = null;
    const deps = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          // No event is ever emitted: nothing came back from the server.
          options.signal?.addEventListener("abort", () => {
            abortedAt = Date.now();
            resolve({
              session: createEmptySessionState({
                id: "s-x",
                workingDir: "/repo",
              }),
              reason: "cancelled",
              stepCount: 0,
            });
          });
        }),
    );
    const run = runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const [result] = await run;

    // A third of its own budget, not the 30-minute global first-token wait.
    expect(abortedAt! - start).toBe(15 * MIN);
    expect(result!.status).toBe("queued");
    expect(result!.stepCount).toBe(0);
    // It ran ALONE: there was nothing to queue behind, so the remedy is
    // not a narrower fan-out. This is the shape of the field case — four
    // solo delegations dead at 45 min while the server log was empty.
    expect(result!.hint).toMatch(/never answered it/i);
    expect(result!.hint).not.toMatch(/fewer workers/i);
    expect(result!.notes?.join(" ")).toMatch(/only worker on the leg/i);
  });

  it("blames the fan-out's width only when the slot table shows there was something to queue behind", async () => {
    vi.useFakeTimers();
    const deps = {
      ...harness(neverAnswered),
      // One slot, working, and a fan-out two wide: one of them queued.
      probeSlotOccupancy: async () => ({ total: 1, busy: 1 }),
    };
    const run = runWorkerTasks(deps, {
      ...BASE,
      localLeg: true,
      tasks: TWO_TASKS,
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const results = await run;
    expect(results[0]!.status).toBe("queued");
    expect(results[0]!.hint).toBe(WORKER_HINT_QUEUED);
    expect(results[0]!.notes?.join(" ")).toContain(
      "the server reported 1 of 1 slot busy",
    );
  });

  it("does not claim a full server from the worker count alone", async () => {
    // Two workers used to be enough for "the local server had no free
    // slot" — said of a two-slot server serving exactly two (ATO-234).
    vi.useFakeTimers();
    const run = runWorkerTasks(harness(neverAnswered), {
      ...BASE,
      tasks: TWO_TASKS,
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const results = await run;
    expect(results[0]!.status).toBe("queued");
    expect(results[0]!.hint).not.toBe(WORKER_HINT_QUEUED);
    expect(results[0]!.hint).toBe(workerHintNoFirstToken(15 * MIN));
  });

  it("gives a served worker its whole budget measured from the first token", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let abortedAt: number | null = null;
    const QUEUED_FOR = 10 * MIN;
    const deps = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            abortedAt = Date.now();
            resolve({
              session: createEmptySessionState({
                id: "s-x",
                workingDir: "/repo",
              }),
              reason: "cancelled",
              stepCount: 4,
            });
          });
          // The slot frees up ten minutes in and the first token lands.
          setTimeout(() => {
            options.eventHook?.({
              type: "llm_event",
              event: { type: "assistant_delta", text: "he" },
            });
          }, QUEUED_FOR);
        }),
    );
    const run = runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(QUEUED_FOR + WORKER_BUDGET + MIN);
    const [result] = await run;

    // The ten minutes it spent queueing are not deducted from its work.
    expect(abortedAt! - start).toBe(QUEUED_FOR + WORKER_BUDGET);
    // Out of time, not out of steps: the orchestrator can act on that.
    expect(result!.status).toBe("timeout");
  });

  it("records how long the server took to answer, so a wedge is visible in the trace", async () => {
    vi.useFakeTimers();
    const QUEUED_FOR = 7 * MIN;
    const deps = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          setTimeout(() => {
            options.eventHook?.({
              type: "llm_event",
              event: { type: "assistant_delta", text: "hi" },
            });
            options.eventHook?.({
              type: "llm_event",
              event: { type: "assistant_reply", text: "done" },
            });
            resolve({
              session: createEmptySessionState({
                id: "s-x",
                workingDir: "/repo",
              }),
              reason: "reply",
              stepCount: 1,
            });
          }, QUEUED_FOR);
        }),
    );
    const run = runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(QUEUED_FOR + MIN);
    const [result] = await run;
    expect(result!.queueWaitMs).toBe(QUEUED_FOR);
    // durationMs minus the wait is the time the worker actually had.
    expect(result!.durationMs - result!.queueWaitMs!).toBe(0);
  });

  it("reports a null wait when nothing ever answered — the wedge signature", async () => {
    vi.useFakeTimers();
    const deps = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({
              session: createEmptySessionState({
                id: "s-x",
                workingDir: "/repo",
              }),
              reason: "cancelled",
              stepCount: 0,
            }),
          );
        }),
    );
    const run = runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const [result] = await run;
    expect(result!.queueWaitMs).toBeNull();
  });

  it("lets the loop's own ceiling outlive the queue wait", async () => {
    vi.useFakeTimers();
    let seen: number | undefined;
    const deps = harness((options) => {
      seen = options.taskMaxDurationMs;
      options.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: "done" },
      });
      return Promise.resolve({
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: "reply" as const,
        stepCount: 1,
      });
    });
    await runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    // The loop's ceiling starts at turn start, which includes the queue
    // wait; leaving it at the worker's budget would cut the work short
    // by however long the worker queued.
    expect(seen).toBe(WORKER_BUDGET + 15 * MIN);
  });
});

describe("a local worker sized for a cloud model (ATO-234)", () => {
  /**
   * The field case: a cloud planner (gpt-5.5) delegated two tasks to a
   * Qwen 3.5 4B on a two-slot llama-server with `timeoutMs: 60000`. Both
   * workers were aborted exactly 20 s after the operator approved — a
   * third of 60 s — while a plain local reply on that machine took ~45 s.
   * The rows then said "the local server had no free slot" and "within 0
   * min", and the call came back ok.
   */
  const PLANNED: DelegateTask[] = TWO_TASKS.map((t) => ({
    ...t,
    timeoutMs: 60_000,
  }));

  it("raises the planner's budget to the local floor and waits at least the first-token floor", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const abortedAt: number[] = [];
    const ceilings: Array<number | undefined> = [];
    const logged: Array<Record<string, unknown> | undefined> = [];
    const deps: WorkerRunnerDeps = {
      ...harness((options) => {
        ceilings.push(options.taskMaxDurationMs);
        options.signal?.addEventListener("abort", () =>
          abortedAt.push(Date.now() - start),
        );
        return neverAnswered(options);
      }),
      // Both slots working — on this fan-out's own two prompts.
      probeSlotOccupancy: async () => ({ total: 2, busy: 2 }),
      logger: { info: (_message, context) => logged.push(context) },
    };
    const run = runWorkerTasks(deps, {
      ...BASE,
      localLeg: true,
      tasks: PLANNED,
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const results = await run;

    // Not 20 s: the first-token floor.
    expect(abortedAt).toEqual([
      LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS,
      LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS,
    ]);
    // The loop's ceiling is the raised budget plus that wait.
    expect(ceilings).toEqual([
      LOCAL_WORKER_TASK_BUDGET_FLOOR_MS + LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS,
      LOCAL_WORKER_TASK_BUDGET_FLOOR_MS + LOCAL_WORKER_FIRST_TOKEN_FLOOR_MS,
    ]);
    for (const result of results) {
      expect(result.status).toBe("queued");
      // Two workers on two slots: nothing was queued behind anything.
      expect(result.hint).toBe(workerHintNoFirstToken(2 * MIN));
      const notes = result.notes?.join(" ") ?? "";
      expect(notes).toContain("timeoutMs 60000 was raised to 300000");
      expect(notes).toContain("no first token within 2 min of being sent");
      expect(notes).toContain("the server reported 2 of 2 slots busy");
      expect(notes).not.toContain("0 min");
    }
    expect(logged).toEqual([
      { taskId: "t0", requestedMs: 60_000, timeoutMs: 300_000 },
      { taskId: "t1", requestedMs: 60_000, timeoutMs: 300_000 },
    ]);
  });

  it("keeps a cloud worker's budget as the planner sized it, and says seconds under a minute", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let abortedAt: number | null = null;
    const run = runWorkerTasks(
      harness((options) => {
        options.signal?.addEventListener("abort", () => {
          abortedAt = Date.now() - start;
        });
        return neverAnswered(options);
      }),
      {
        ...BASE,
        providerId: "openrouter",
        tasks: [PLANNED[0]!],
        maxWorkers: 1,
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const [result] = await run;
    expect(abortedAt).toBe(20_000);
    expect(result!.notes?.join(" ")).toContain("no first token within 20 s");
    expect(result!.notes?.join(" ")).not.toContain("raised");
  });

  it("leaves an operator's shorter configured budget alone", async () => {
    vi.useFakeTimers();
    let ceiling: number | undefined;
    const run = runWorkerTasks(
      harness((options) => {
        ceiling = options.taskMaxDurationMs;
        return neverAnswered(options);
      }),
      {
        ...BASE,
        workerTimeoutMs: 2 * MIN,
        localLeg: true,
        tasks: [PLANNED[0]!],
        maxWorkers: 1,
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(10 * MIN);
    const [result] = await run;
    // The floor stops at the configured 2 min, and the first-token
    // floor at the worker's own budget.
    expect(ceiling).toBe(2 * MIN + 2 * MIN);
    expect(result!.notes?.join(" ")).toContain(
      "timeoutMs 60000 was raised to 120000",
    );
  });

  it("names a server whose every slot was idle as the suspect, not the fan-out", async () => {
    vi.useFakeTimers();
    const run = runWorkerTasks(
      {
        ...harness(neverAnswered),
        probeSlotOccupancy: async () => ({ total: 2, busy: 0 }),
      },
      {
        ...BASE,
        localLeg: true,
        tasks: TWO_TASKS,
        maxWorkers: 2,
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const results = await run;
    expect(results[0]!.hint).toBe(WORKER_HINT_IDLE_SERVER);
  });

  it("does not end a worker whose first token lands while the slot table is being read", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let abortedAt: number | null = null;
    const deps: WorkerRunnerDeps = {
      ...harness(
        (options) =>
          new Promise<RunTurnResult>((resolve) => {
            options.signal?.addEventListener("abort", () => {
              abortedAt = Date.now() - start;
              resolve({
                session: createEmptySessionState({
                  id: "s-x",
                  workingDir: "/repo",
                }),
                reason: "cancelled",
                stepCount: 1,
              });
            });
            // The token arrives one second after the probe was sent.
            setTimeout(() => {
              options.eventHook?.({
                type: "llm_event",
                event: { type: "assistant_delta", text: "he" },
              });
            }, 15 * MIN + 1_000);
          }),
      ),
      probeSlotOccupancy: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ total: 1, busy: 1 }), 2_000),
        ),
    };
    const run = runWorkerTasks(deps, {
      ...BASE,
      localLeg: true,
      tasks: TASK,
      maxWorkers: 1,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(15 * MIN + WORKER_BUDGET + MIN);
    const [result] = await run;
    // Served at 15 min + 1 s: its wall clock ran from there.
    expect(abortedAt).toBe(15 * MIN + 1_000 + WORKER_BUDGET);
    expect(result!.status).toBe("timeout");
  });

  it("still ends the worker when the slot probe never settles", async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let abortedAt: number | null = null;
    const run = runWorkerTasks(
      {
        ...harness((options) => {
          options.signal?.addEventListener("abort", () => {
            abortedAt = Date.now() - start;
          });
          return neverAnswered(options);
        }),
        probeSlotOccupancy: () => new Promise(() => {}),
      },
      {
        ...BASE,
        localLeg: true,
        tasks: TASK,
        maxWorkers: 1,
        signal: new AbortController().signal,
      },
    );
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const [result] = await run;
    expect(abortedAt).toBe(15 * MIN + QUEUE_SLOT_PROBE_TIMEOUT_MS);
    expect(result!.status).toBe("queued");
    expect(result!.notes?.join(" ")).toContain(
      "the server's slot table could not be read",
    );
    // An unreadable table is no evidence of a dead server.
    expect(result!.hint).toBe(workerHintNoFirstToken(15 * MIN));
  });
});
