import { describe, it, expect, vi, afterEach } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import {
  LocalLegHealth,
  LOCAL_LEG_UNRESPONSIVE_ERROR,
  type LocalHealthAnswer,
} from "./local-leg-health.js";
import type { DelegateTask } from "./delegate-args.js";

const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

function harness(
  runTurn: (
    options: Parameters<WorkerRunnerDeps["runTurn"]>[2],
  ) => Promise<RunTurnResult>,
  extra: Partial<WorkerRunnerDeps>,
): WorkerRunnerDeps & { turns: number } {
  let minted = 0;
  const deps = {
    turns: 0,
    runTurn: (_session: SessionState, _msg: string, options: Parameters<WorkerRunnerDeps["runTurn"]>[2]) => {
      deps.turns += 1;
      return runTurn(options);
    },
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
    ...extra,
  };
  return deps;
}

const TASK: DelegateTask[] = [{ id: "t0", title: "Task 0", instructions: "x" }];

const BASE = {
  parentSessionId: "s-parent",
  providerId: "local-llama",
  workerModel: "gemma",
  workerMaxSteps: 7,
  workerTimeoutMs: 45 * MIN,
  localLeg: true,
  maxWorkers: 1,
};

/** Served (one token), then generates until its clock cuts it. */
function servedThenHung(
  options: Parameters<WorkerRunnerDeps["runTurn"]>[2],
): Promise<RunTurnResult> {
  options.eventHook?.({
    type: "llm_event",
    event: { type: "assistant_delta", delta: "…" },
  } as never);
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

function okTurn(): Promise<RunTurnResult> {
  return Promise.resolve({
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "finished",
    stepCount: 1,
  } as RunTurnResult);
}

describe("dispatch after a cut-off local worker (ATO-917)", () => {
  it("fails the next worker at once when the server stopped answering", async () => {
    vi.useFakeTimers();
    const health = new LocalLegHealth();
    let probes = 0;
    const probe = async (): Promise<LocalHealthAnswer> => {
      probes += 1;
      return "unanswered";
    };
    const first = harness(servedThenHung, {
      localLegHealth: health,
      probeLocalHealth: probe,
    });
    const run1 = runWorkerTasks(first, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(46 * MIN);
    const [cut] = await run1;
    expect(cut!.status).toBe("timeout");
    expect(health.isSuspect()).toBe(true);
    // Nothing was asked before the first dispatch: nothing had been cut.
    expect(probes).toBe(0);

    const second = harness(okTurn, {
      localLegHealth: health,
      probeLocalHealth: probe,
    });
    const run2 = runWorkerTasks(second, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const [refused] = await run2;
    expect(second.turns).toBe(0);
    expect(refused!.status).toBe("failed");
    expect(refused!.error).toBe(LOCAL_LEG_UNRESPONSIVE_ERROR);
    expect(refused!.hint).toMatch(/restart the local server/);
    expect(refused!.notes?.join(" ")).toMatch(/task t0 was timed out/);
    expect(probes).toBe(2);
  });

  it("dispatches as before once the server answers, and clears the mark", async () => {
    const health = new LocalLegHealth();
    health.noteCut("task t9 was cancelled");
    const deps = harness(okTurn, {
      localLegHealth: health,
      probeLocalHealth: async () => "answered",
    });
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    expect(deps.turns).toBe(1);
    expect(result!.status).not.toBe("failed");
    expect(health.isSuspect()).toBe(false);
  });

  it("never probes a cloud leg", async () => {
    const health = new LocalLegHealth();
    health.noteCut("x");
    let probes = 0;
    const deps = harness(okTurn, {
      localLegHealth: health,
      probeLocalHealth: async () => {
        probes += 1;
        return "unanswered";
      },
    });
    await runWorkerTasks(deps, {
      ...BASE,
      localLeg: false,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    expect(probes).toBe(0);
    expect(deps.turns).toBe(1);
  });
});
