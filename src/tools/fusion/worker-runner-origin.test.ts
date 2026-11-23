import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import type { EscalationComplete } from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

// The worker turn's origin from the options (ATO-1669) reaches every
// runTurn the runner makes, the escalation model's re-run included.
// Same doubles as escalation.test.ts.

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

const TARGET: FusionEscalationTarget = {
  providerId: "cloud",
  model: "big",
  auto: true,
  replace: true,
  maxUsd: 0.25,
};
const PRICING = { input: 1, output: 4 };
const TASK: DelegateTask[] = [{ id: "t0", title: "T0", instructions: "write a.txt" }];
const BASE = {
  parentSessionId: "s-parent",
  providerId: "local",
  workerModel: "small",
  workerMaxSteps: 20,
  workerTimeoutMs: 600_000,
  maxWorkers: 1,
};

/** One completed step whose only result is the same failing read. */
function sameStep(hook: TurnOptions["eventHook"], i: number): void {
  hook?.({
    type: "llm_event",
    event: {
      type: "tool_call_executed",
      result: { tool: "os.fs.read", status: "error", summary: "not found: a.txt", details: {} },
    },
  } as never);
  hook?.({ type: "step_finished", stepIndex: i, summary: "", durationMs: 1 } as AgentLoopEvent);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  let minted = 0;
  const seen: Array<{ providerId: string; origin: TurnOptions["origin"] }> = [];
  const complete: EscalationComplete = async () => ({
    content: "Stop reading a.txt; it does not exist yet. Write it with os.fs.write.",
    usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
  });
  const deps: WorkerRunnerDeps = {
    runTurn: async (_session, _msg, options) => {
      seen.push({ providerId: options.providerId ?? "", origin: options.origin });
      if (options.providerId === "cloud") {
        return {
          session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
          reason: "reply",
          stepCount: 3,
        } as RunTurnResult;
      }
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      for (let i = 3; i < 6; i += 1) sameStep(options.eventHook, i);
      // The replace abort lands here.
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: options.signal?.aborted ? "cancelled" : "reply",
        stepCount: 6,
      } as RunTurnResult;
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
    escalationComplete: complete,
    steerWorker: () => true,
  };
  return { deps, seen };
}

describe("worker turn origin (ATO-1669)", () => {
  it("passes the subagent origin to the local turn and to the escalation re-run", async () => {
    const h = harness();
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
      origin: "subagent",
    });
    expect(h.seen.map((s) => s.providerId)).toEqual(["local", "cloud"]);
    expect(h.seen.map((s) => s.origin)).toEqual(["subagent", "subagent"]);
    expect(row!.notes?.join("\n")).toMatch(/re-run on big after the local worker stayed stuck/);
  });

  it("keeps the fusion origin on both turns when the options name none", async () => {
    const h = harness();
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(h.seen.map((s) => s.origin)).toEqual(["fusion", "fusion"]);
  });
});
