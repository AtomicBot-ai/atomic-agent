import { describe, expect, it } from "vitest";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { AgentLoopEvent } from "../../agent/agent-contract.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import type { FusionEscalationTarget } from "../../llm/run-mode/index.js";
import { runWorkerTasks, type WorkerRunnerDeps } from "./worker-runner.js";
import { FusionLiveWorkers, type EscalationComplete } from "./escalation.js";
import type { DelegateTask } from "./delegate-args.js";

type TurnOptions = Parameters<WorkerRunnerDeps["runTurn"]>[2];

const TARGET: FusionEscalationTarget = {
  providerId: "cloud",
  model: "big",
  auto: true,
  replace: false,
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

function done(): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 3,
  } as RunTurnResult;
}

function harness(
  runTurn: (session: SessionState, options: TurnOptions) => Promise<RunTurnResult>,
  extra: Partial<WorkerRunnerDeps> = {},
) {
  let minted = 0;
  const events: AgentLoopEvent[] = [];
  const steers: string[] = [];
  const calls: string[] = [];
  const complete: EscalationComplete = async ({ providerId }) => {
    calls.push(providerId);
    return {
      content: "Stop reading a.txt; it does not exist yet. Write it with os.fs.write.",
      usage: { promptTokens: 1_000, completionTokens: 200, totalTokens: 1_200 },
    };
  };
  const deps: WorkerRunnerDeps = {
    runTurn: (session, _msg, options) => runTurn(session, options),
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: (_id, event) => events.push(event),
    workingDir: "/repo",
    escalationComplete: complete,
    steerWorker: (_id, text) => {
      steers.push(text);
      return true;
    },
    ...extra,
  };
  return { deps, events, steers, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("advisor escalation of a stuck worker (ATO-942)", () => {
  it("asks the escalation model once on a stall and steers the worker with its hint", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 6; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
    });
    expect(h.calls).toEqual(["cloud"]);
    expect(h.steers[0]).toMatch(/Advice from a stronger model \(big\)/);
    // 1000 in at $1/M + 200 out at $4/M.
    expect(row!.notes?.join("\n")).toMatch(
      /escalated to big as advisor \(stalled: same result 3×\): \$0\.0018/,
    );
    const escalated = h.events.filter(
      (e) => e.type === "fusion_worker" && e.phase === "escalated",
    );
    expect(escalated.length).toBeGreaterThanOrEqual(2);
  });

  it("does nothing automatically when escalation is not turned on", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 6; i += 1) sameStep(options.eventHook, i);
      return done();
    });
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, auto: false }, pricing: PRICING },
    });
    expect(h.calls).toEqual([]);
  });

  it("does not make a call whose worst case is over the escalation cap", async () => {
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, maxUsd: 0.000001 }, pricing: PRICING },
    });
    expect(h.calls).toEqual([]);
    expect(row!.notes?.join("\n")).toMatch(/over the escalation cap/);
  });

  it("counts the escalation in the turn's spend and stops escalating once the cap is reached", async () => {
    const spent: number[] = [];
    const h = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
      onEscalationSpend: (_t, usd) => spent.push(usd),
    });
    expect(spent[0]).toBeCloseTo(0.0018);

    const capped = harness(async (_s, options) => {
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      return done();
    });
    await runWorkerTasks(capped.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: TARGET, pricing: PRICING },
      // The task itself was allowed to start; the cap is reached by then.
      shouldStart: (() => {
        let first = true;
        return () => {
          if (first) {
            first = false;
            return undefined;
          }
          return "the spend cap for this turn is reached";
        };
      })(),
    });
    expect(capped.calls).toEqual([]);
  });

  it("re-runs the task on the escalation model only behind the replace flag", async () => {
    const providers: string[] = [];
    const h = harness(async (_s, options) => {
      providers.push(options.providerId ?? "");
      if (options.providerId === "cloud") return done();
      for (let i = 0; i < 3; i += 1) sameStep(options.eventHook, i);
      await flush();
      for (let i = 3; i < 6; i += 1) sameStep(options.eventHook, i);
      // The replace abort lands here.
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: options.signal?.aborted ? "cancelled" : "reply",
        stepCount: 6,
      } as RunTurnResult;
    });
    const [row] = await runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, replace: true }, pricing: PRICING },
    });
    expect(providers).toEqual(["local", "cloud"]);
    expect(row!.status).toBe("ok");
    expect(row!.notes?.join("\n")).toMatch(/re-run on big after the local worker stayed stuck/);
  });
});

describe("the person's stop and escalate on one worker (ATO-66)", () => {
  it("escalates a running worker on request and stops it alone", async () => {
    const live = new FusionLiveWorkers();
    let release!: () => void;
    const h = harness(
      (_s, options) =>
        new Promise<RunTurnResult>((resolve) => {
          release = () => resolve(done());
          options.signal?.addEventListener("abort", () =>
            resolve({ ...done(), reason: "cancelled" } as RunTurnResult),
          );
        }),
      { liveWorkers: live },
    );
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
      escalation: { target: { ...TARGET, auto: false }, pricing: PRICING },
    });
    await flush();
    expect(live.running("s-parent")).toEqual(["t0"]);
    const line = await live.escalate("s-parent", "t0");
    expect(line).toMatch(/escalated to big as advisor \(the person asked for it\)/);
    expect(h.calls).toEqual(["cloud"]);
    expect(live.stop("s-parent", "t0")).toBe(true);
    const [row] = await run;
    void release;
    expect(row!.status).toBe("cancelled");
    expect(row!.notes).toContain("stopped by the person");
    expect(live.running("s-parent")).toEqual([]);
    expect(live.stop("s-parent", "t0")).toBe(false);
  });

  it("cannot escalate without a configured target", async () => {
    const live = new FusionLiveWorkers();
    const h = harness(
      (_s, options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({ ...done(), reason: "cancelled" } as RunTurnResult),
          );
        }),
      { liveWorkers: live },
    );
    const run = runWorkerTasks(h.deps, {
      ...BASE,
      tasks: TASK,
      signal: new AbortController().signal,
    });
    await flush();
    expect(await live.escalate("s-parent", "t0")).toMatch(/no configured model/);
    live.stop("s-parent", "t0");
    await run;
    expect(h.calls).toEqual([]);
  });
});
