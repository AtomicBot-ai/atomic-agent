import { describe, it, expect } from "vitest";
import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { SessionState } from "../../session/session-state.js";
import type { FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import {
  estimateWorkerTimeoutMs,
  fitReplyCapToTime,
  runWorkerTasks,
  WORKER_REPLY_CAP_FLOOR_TOKENS,
  type WorkerRunnerDeps,
} from "./worker-runner.js";
import type { DelegateTask } from "./delegate-args.js";

/**
 * ATO-214 — a local worker's reply cap is sized to the time it has.
 *
 * Issue #490: a worker's first answer ran to 7–11k tokens at
 * 3–4.3 tok/s under a 16,384-token cap (≈ 64 min at that speed), the
 * 45-minute clock cut it mid-generation, and the task came back with
 * 0 steps and nothing that said why.
 */

type Options = Parameters<WorkerRunnerDeps["runTurn"]>[2];

function harness(runTurn: (options: Options) => Promise<RunTurnResult>): {
  deps: WorkerRunnerDeps;
  calls: Array<{ userMessage: string; options: Options }>;
} {
  const calls: Array<{ userMessage: string; options: Options }> = [];
  let minted = 0;
  return {
    calls,
    deps: {
      runTurn: (_session: SessionState, userMessage: string, options) => {
        calls.push({ userMessage, options });
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
    },
  };
}

function turnResult(over: Partial<RunTurnResult> = {}): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 1,
    ...over,
  };
}

/** The first token: the worker is served and its wall clock starts. */
const SERVED: AgentLoopEvent = {
  type: "llm_event",
  event: { type: "reasoning_delta", stepIndex: 0, text: "…" },
};

/** A finished completion that generated `predictedTokens`. */
function completed(predictedTokens: number): AgentLoopEvent {
  return {
    type: "llm_event",
    event: {
      type: "llm_completed",
      completion: {
        content: "",
        reasoningContent: "",
        stop: true,
        truncated: false,
        timing: { promptMs: 1, predictedMs: 1, promptTokens: 9_000, predictedTokens },
        cacheHitTokens: 0,
        slotId: 0,
        modelId: "m",
      },
    },
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
  tasks: TASK,
  maxWorkers: 1,
};

describe("fitReplyCapToTime", () => {
  it("leaves the cap alone when no speed was measured (a cloud leg, a cold local one)", () => {
    for (const tokensPerSecond of [null, undefined, 0, -1, Number.NaN]) {
      expect(
        fitReplyCapToTime({
          tokensPerSecond,
          remainingMs: 2_700_000,
          capTokens: 16_384,
        }),
      ).toBeUndefined();
    }
  });

  it("fits issue #490's machine: 4.27 tok/s for 45 min is 9,223 tokens, not 16,384", () => {
    // floor(4.27 × 2,700 s × 0.8)
    expect(
      fitReplyCapToTime({
        tokensPerSecond: 4.27,
        remainingMs: 2_700_000,
        capTokens: 16_384,
      }),
    ).toBe(9_223);
  });

  it("never raises the cap in force: a fast machine keeps it", () => {
    expect(
      fitReplyCapToTime({
        tokensPerSecond: 40,
        remainingMs: 2_700_000,
        capTokens: 16_384,
      }),
    ).toBeUndefined();
  });

  it("bounds an uncapped reply (0 or no cap) by the clock alone", () => {
    for (const capTokens of [0, undefined]) {
      expect(
        fitReplyCapToTime({
          tokensPerSecond: 40,
          remainingMs: 2_700_000,
          capTokens,
        }),
      ).toBe(86_400);
    }
  });

  it("does not go below the floor, and a cap below the floor stays as it is", () => {
    expect(
      fitReplyCapToTime({
        tokensPerSecond: 0.5,
        remainingMs: 60_000,
        capTokens: 16_384,
      }),
    ).toBe(WORKER_REPLY_CAP_FLOOR_TOKENS);
    expect(
      fitReplyCapToTime({
        tokensPerSecond: 0.5,
        remainingMs: 60_000,
        capTokens: 512,
      }),
    ).toBeUndefined();
  });
});

describe("a local worker's reply cap follows its time limit (ATO-214)", () => {
  it("sends the time-fitted cap on a measured local leg, below the configured one", async () => {
    const { deps, calls } = harness(async () => turnResult());
    await runWorkerTasks(deps, {
      ...BASE,
      workerTimeoutMs: 2_700_000,
      localTokensPerSecond: 4,
      workerMaxOutputTokens: 16_384,
      signal: new AbortController().signal,
    });
    const timeoutMs = estimateWorkerTimeoutMs({
      briefChars: calls[0]!.userMessage.length,
      declaredFiles: 0,
      tokensPerSecond: 4,
      ceilingMs: 2_700_000,
    });
    const expected = fitReplyCapToTime({
      tokensPerSecond: 4,
      remainingMs: timeoutMs,
      capTokens: 16_384,
    });
    expect(expected).toBeDefined();
    expect(expected!).toBeLessThan(16_384);
    expect(calls[0]!.options.maxOutputTokens).toBe(expected);
  });

  it("keeps the configured cap where the clock does not bind: unmeasured, cloud, or fast", async () => {
    for (const localTokensPerSecond of [null, undefined, 200]) {
      const { deps, calls } = harness(async () => turnResult());
      await runWorkerTasks(deps, {
        ...BASE,
        workerTimeoutMs: 2_700_000,
        ...(localTokensPerSecond === undefined ? {} : { localTokensPerSecond }),
        workerMaxOutputTokens: 16_384,
        signal: new AbortController().signal,
      });
      expect(calls[0]!.options.maxOutputTokens).toBe(16_384);
    }
    // And no cap at all where none was set and nothing was measured.
    const plain = harness(async () => turnResult());
    await runWorkerTasks(plain.deps, {
      ...BASE,
      workerTimeoutMs: 2_700_000,
      localTokensPerSecond: null,
      signal: new AbortController().signal,
    });
    expect(plain.calls[0]!.options).not.toHaveProperty("maxOutputTokens");
  });

  it("says the first answer was cut by the time limit, not just 0 steps, when the clock ends it", async () => {
    // 40 ms budget at 4 tok/s: the fitted cap is the floor, 1,024.
    const { deps, calls } = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.eventHook?.({ type: "turn_started", turnIndex: 0 });
          options.eventHook?.(SERVED);
          options.eventHook?.(completed(WORKER_REPLY_CAP_FLOOR_TOKENS));
          options.signal!.addEventListener(
            "abort",
            () => resolve(turnResult({ reason: "cancelled", stepCount: 0 })),
            { once: true },
          );
        }),
    );
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerTimeoutMs: 40,
      localTokensPerSecond: 4,
      workerMaxOutputTokens: 16_384,
      signal: new AbortController().signal,
    });
    expect(calls[0]!.options.maxOutputTokens).toBe(
      WORKER_REPLY_CAP_FLOOR_TOKENS,
    );
    expect(result).toMatchObject({ status: "timeout", stepCount: 0 });
    expect(result!.reply).toBe(
      "the first answer was cut at 1024 tokens by the time limit, before any step completed",
    );
    expect(result!.notes?.[0]).toMatch(
      /^the first answer was cut at 1024 tokens by the time limit: at the measured 4\.0 tok\/s a .+ limit leaves room for about 1024 tokens per answer, and no step completed$/,
    );
    // The loop's own time-limit note is still there, after it.
    expect(result!.notes?.slice(1).join(" ")).toMatch(/time limit/);
    expect(result!.hint).toMatch(/longer timeoutMs/);
  });

  it("adds the same account beside the error when the cut answer fails the turn", async () => {
    const lastError =
      "model response truncated at 1024 tokens: it spent the reply cap (localModels.completionMaxTokens) of 1024 — raise it, or use a model that thinks less before answering";
    const { deps } = harness(async (options) => {
      options.eventHook?.(SERVED);
      options.eventHook?.(completed(1_020));
      return turnResult({
        reason: "failed",
        stepCount: 0,
        session: {
          ...createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
          lastError,
        },
      });
    });
    const [result] = await runWorkerTasks(deps, {
      ...BASE,
      workerTimeoutMs: 1_000,
      localTokensPerSecond: 4,
      signal: new AbortController().signal,
    });
    // The failing layer's words stay; the account sits beside them.
    expect(result).toMatchObject({ status: "failed", error: lastError });
    expect(result!.notes?.[0]).toMatch(
      /^the first answer was cut at 1020 tokens by the time limit/,
    );
    expect(result!.hint).toMatch(/longer timeoutMs/);
  });

  it("says nothing about a cut once a step has completed, or when the clock set no cap", async () => {
    const afterStep = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.eventHook?.(SERVED);
          options.eventHook?.({
            type: "step_finished",
            stepIndex: 0,
            summary: "os.fs.read ok",
            durationMs: 1,
          });
          options.eventHook?.(completed(WORKER_REPLY_CAP_FLOOR_TOKENS));
          options.signal!.addEventListener(
            "abort",
            () => resolve(turnResult({ reason: "cancelled", stepCount: 1 })),
            { once: true },
          );
        }),
    );
    const [stepped] = await runWorkerTasks(afterStep.deps, {
      ...BASE,
      workerTimeoutMs: 40,
      localTokensPerSecond: 4,
      signal: new AbortController().signal,
    });
    expect(stepped).toMatchObject({ status: "timeout", stepCount: 1 });
    expect(stepped!.notes?.join(" ")).not.toMatch(/first answer was cut/);

    const unmeasured = harness(
      (options) =>
        new Promise<RunTurnResult>((resolve) => {
          options.eventHook?.(SERVED);
          options.eventHook?.(completed(16_384));
          options.signal!.addEventListener(
            "abort",
            () => resolve(turnResult({ reason: "cancelled", stepCount: 0 })),
            { once: true },
          );
        }),
    );
    const [cold] = await runWorkerTasks(unmeasured.deps, {
      ...BASE,
      workerTimeoutMs: 40,
      localTokensPerSecond: null,
      signal: new AbortController().signal,
    });
    expect(cold).toMatchObject({ status: "timeout", stepCount: 0 });
    expect(cold!.reply).not.toMatch(/first answer was cut/);
    expect(cold!.notes?.join(" ")).not.toMatch(/first answer was cut/);
  });
});
