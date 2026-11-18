import { describe, expect, it } from "vitest";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import {
  FUSION_WORKER_ID_PREFIX,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import type { DelegateTask } from "./delegate-args.js";
import {
  DEFAULT_WORKER_TURN_ORIGIN,
  runWorkerTasksCore,
  type WorkerRunnerCoreDeps,
  type WorkerRunnerCoreOptions,
} from "./worker-runner.js";

// The shared runner given only the core fields (ATO-1669): no Fusion
// add-on is set anywhere below, and a worker turn still runs to a row.

type RunTurnCall = {
  session: SessionState;
  userMessage: string;
  options: Parameters<WorkerRunnerCoreDeps["runTurn"]>[2];
};

function coreHarness(reply: string): {
  deps: WorkerRunnerCoreDeps;
  calls: RunTurnCall[];
  policies: Array<{ op: "set" | "clear"; sessionId: string }>;
  events: Array<{ sessionId: string; event: AgentLoopEvent }>;
} {
  const calls: RunTurnCall[] = [];
  const policies: Array<{ op: "set" | "clear"; sessionId: string }> = [];
  const events: Array<{ sessionId: string; event: AgentLoopEvent }> = [];
  let minted = 0;
  const deps: WorkerRunnerCoreDeps = {
    runTurn: async (session, userMessage, options) => {
      calls.push({ session, userMessage, options });
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: reply },
      });
      const result: RunTurnResult = {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: "reply",
        stepCount: 2,
      };
      return result;
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

const TASK: DelegateTask = {
  id: "t0",
  title: "Task 0",
  instructions: "Find the answer",
};

function coreOptions(
  over: Partial<WorkerRunnerCoreOptions> = {},
): WorkerRunnerCoreOptions {
  return {
    parentSessionId: "s-parent",
    tasks: [TASK],
    maxWorkers: 1,
    providerId: "cloud-model",
    workerModel: "some-model",
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("runWorkerTasksCore (ATO-1669)", () => {
  it("runs a worker turn with only core options and returns its parsed row", async () => {
    const { deps, calls, policies, events } = coreHarness("the answer");
    const results = await runWorkerTasksCore(deps, coreOptions());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.session.id).not.toBe("s-parent");
    expect(calls[0]!.userMessage).toContain("Find the answer");
    expect(calls[0]!.options).toMatchObject({
      providerId: "cloud-model",
      maxSteps: 7,
      toolRole: "builder",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "t0",
      status: "ok",
      reply: "the answer",
      stepCount: 2,
    });
    // The approval policy is armed and disarmed around the turn.
    expect(policies).toEqual([
      { op: "set", sessionId: calls[0]!.session.id },
      { op: "clear", sessionId: calls[0]!.session.id },
    ]);
    // Progress lands in the parent's frame.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.sessionId === "s-parent")).toBe(true);
  });

  it("runs the turn under the fusion origin when none is given", async () => {
    const { deps, calls } = coreHarness("done");
    await runWorkerTasksCore(deps, coreOptions());
    expect(DEFAULT_WORKER_TURN_ORIGIN).toBe("fusion");
    expect(calls[0]!.options.origin).toBe("fusion");
  });

  it("runs the turn under the subagent origin when the options name it", async () => {
    const { deps, calls } = coreHarness("done");
    const results = await runWorkerTasksCore(
      deps,
      coreOptions({ origin: "subagent" }),
    );
    expect(calls[0]!.options.origin).toBe("subagent");
    expect(results[0]!.status).toBe("ok");
  });
});
