import { describe, it, expect, vi, afterEach } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
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

  it("blames the fan-out's width only when there was something to queue behind", async () => {
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
      tasks: [
        { id: "t0", title: "Task 0", instructions: "one" },
        { id: "t1", title: "Task 1", instructions: "two" },
      ],
      maxWorkers: 2,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(WORKER_BUDGET + MIN);
    const results = await run;
    expect(results[0]!.status).toBe("queued");
    expect(results[0]!.hint).toMatch(/fewer workers/i);
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
