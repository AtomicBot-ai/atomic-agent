import { describe, it, expect } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import { LocalLegHealth } from "./local-leg-health.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * ATO-1357 / issue #490: after a local worker was cut off, no later
 * worker's request reached the server — `/health` answered, every slot
 * was idle — until the agent was restarted. The dispatch after a cut on
 * a server that answers now renews the process's HTTP pool first, the
 * transport half of that restart, and says so in the log.
 */

const MIN = 60_000;

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

function okTurn(): Promise<RunTurnResult> {
  return Promise.resolve({
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 1,
  } as RunTurnResult);
}

function harness(extra: Partial<WorkerRunnerDeps>): WorkerRunnerDeps & {
  order: string[];
  infos: Array<{ message: string; context: Record<string, unknown> | undefined }>;
} {
  let minted = 0;
  const order: string[] = [];
  const infos: Array<{ message: string; context: Record<string, unknown> | undefined }> = [];
  return {
    order,
    infos,
    runTurn: (_session: SessionState, _msg: string) => {
      order.push("turn");
      return okTurn();
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
    logger: {
      info: (message: string, context?: Record<string, unknown>) => {
        infos.push({ message, context });
      },
    } as WorkerRunnerDeps["logger"],
    ...extra,
  };
}

describe("fresh connections for the local leg after a cut-off worker (ATO-1357)", () => {
  it("renews the pool before the next worker is sent, when the server still answers", async () => {
    const health = new LocalLegHealth();
    health.noteCut("task t9 was timed out");
    const deps = harness({ localLegHealth: health, probeLocalHealth: async () => "answered" });
    let renewals = 0;
    deps.renewLocalTransport = () => {
      renewals += 1;
      deps.order.push("renew");
      return true;
    };
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    expect(result!.status).not.toBe("failed");
    expect(renewals).toBe(1);
    // Before the request, not after it: the point is that the worker's
    // first completion goes out on a fresh socket.
    expect(deps.order).toEqual(["renew", "turn"]);
    expect(health.isSuspect()).toBe(false);
    const line = deps.infos.find((entry) => entry.message.includes("fresh connections"));
    expect(line?.context).toMatchObject({ taskId: "t0", renewed: true });
    // The dispatch line ties the client's session-keyed trace to the task.
    const dispatched = deps.infos.find((entry) => entry.message.includes("local worker dispatched"));
    expect(dispatched?.context).toMatchObject({ taskId: "t0", afterCut: true });
  });

  it("does not renew anything when no worker was cut", async () => {
    const deps = harness({
      localLegHealth: new LocalLegHealth(),
      probeLocalHealth: async () => "answered",
    });
    let renewals = 0;
    deps.renewLocalTransport = () => {
      renewals += 1;
      return true;
    };
    await runWorkerTasks(deps, { ...BASE, tasks: TASK, signal: new AbortController().signal });
    expect(renewals).toBe(0);
  });

  it("does not renew for a server that stopped answering: that worker is refused instead", async () => {
    const health = new LocalLegHealth();
    health.noteCut("task t9 was cancelled");
    const deps = harness({
      localLegHealth: health,
      probeLocalHealth: async () => "unanswered",
    });
    let renewals = 0;
    deps.renewLocalTransport = () => {
      renewals += 1;
      return true;
    };
    const [refused] = await runWorkerTasks(deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    expect(refused!.status).toBe("failed");
    expect(deps.order).toEqual([]);
    expect(renewals).toBe(0);
    // The check waits LOCAL_LEG_HEALTH_RETRY_MS (2 s) between its two asks.
  }, 10_000);

  it("never touches the pool for a cloud leg", async () => {
    const health = new LocalLegHealth();
    health.noteCut("x");
    const deps = harness({ localLegHealth: health, probeLocalHealth: async () => "answered" });
    let renewals = 0;
    deps.renewLocalTransport = () => {
      renewals += 1;
      return true;
    };
    await runWorkerTasks(deps, {
      ...BASE,
      localLeg: false,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    expect(renewals).toBe(0);
    expect(deps.order).toEqual(["turn"]);
  });
});
