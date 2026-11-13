import { describe, expect, it } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { applyCheckOutcomes } from "./contract-checks.js";
import { UNDELIVERED_STATUSES } from "./contract-waves.js";
import { FanoutFailureBreaker } from "./failure-breaker.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { renderWorkerBrief } from "./worker-prompt.js";
import {
  MAX_WORKER_QUESTION_CHARS,
  NEEDS_INPUT_MARKER,
  WORKER_NEEDS_INPUT_NOTE,
  readWorkerQuestion,
} from "./worker-question.js";
import { formatDelegateOutput, type WorkerTaskResult } from "./worker-result.js";

/**
 * ATO-945: a worker cannot ask the orchestrator mid-task (its turn is
 * blocked inside the delegate call), so it ends its task with a
 * question instead; the orchestrator answers and sends the task again.
 */

const logger = new StructuredLogger({ level: "error", sinks: [] });

function fusionMode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "local-llama",
    workerModel: "small",
    workers: 3,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    ...over,
  };
}

function ctx(): ToolContext {
  return {
    workingDir: "/repo",
    sessionId: "s-parent",
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}

function turnResult(over: Partial<RunTurnResult> = {}): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
    reason: "reply",
    stepCount: 1,
    ...over,
  };
}

function deps(runTurn: FusionDelegateDeps["runTurn"]): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn,
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
      fanoutScopes: new FanoutScopeRegistry(),
    },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => fusionMode(),
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
  };
}

const QUESTION = "Should the score in js/hud.js be the run's total or the best lap?";

/**
 * t1 asks until its brief carries the answer; t2 just finishes. Every
 * brief is recorded, so a test can read what the re-sent worker got.
 */
function scripted(briefs: string[]): FusionDelegateDeps["runTurn"] {
  return async (_session, userMessage, options) => {
    briefs.push(userMessage);
    const text = userMessage.includes("Score task")
      ? userMessage.includes("ANSWER: the best lap")
        ? "wrote js/hud.js showing the best lap"
        : `I read js/hud.js; the brief does not say which score.\n${NEEDS_INPUT_MARKER} ${QUESTION}`
      : "done";
    options.eventHook?.({
      type: "llm_event",
      event: { type: "assistant_reply", text },
    });
    return turnResult();
  };
}

describe("readWorkerQuestion", () => {
  it("reads the question after the marker", () => {
    expect(readWorkerQuestion(`tried things\n${NEEDS_INPUT_MARKER} ${QUESTION}`)).toBe(
      QUESTION,
    );
  });

  it("joins continuation lines and stops at a blank line", () => {
    expect(
      readWorkerQuestion("NEEDS_INPUT: which file\nowns the score?\n\nnotes after"),
    ).toBe("which file owns the score?");
  });

  it("accepts markdown emphasis around the marker", () => {
    expect(readWorkerQuestion("**NEEDS_INPUT:** which port?")).toBe("which port?");
  });

  it("ignores a marker that does not start a line, and an empty question", () => {
    expect(readWorkerQuestion("I could have written NEEDS_INPUT: x but did not")).toBeUndefined();
    expect(readWorkerQuestion("NEEDS_INPUT:   \n\nmore")).toBeUndefined();
    expect(readWorkerQuestion("all done")).toBeUndefined();
  });

  it("is bounded", () => {
    const q = readWorkerQuestion(`NEEDS_INPUT: ${"why ".repeat(200)}`);
    expect(q!.length).toBeLessThanOrEqual(MAX_WORKER_QUESTION_CHARS);
    expect(q!.endsWith("…")).toBe(true);
  });
});

describe("the worker brief tells a worker how to ask", () => {
  it("names the marker and still forbids waiting", () => {
    const brief = renderWorkerBrief(
      { id: "t1", title: "One", instructions: "Do one" },
      { workingDir: "/repo" },
    );
    expect(brief).toContain(NEEDS_INPUT_MARKER);
    expect(brief).toMatch(/Never ask a question mid-task/);
  });
});

describe("fusion.delegate — a worker that needs input", () => {
  it("comes back needs_input with the question on the row and in the table", async () => {
    const briefs: string[] = [];
    const tool = buildFusionDelegateTool(deps(scripted(briefs)));
    const result = await tool.run(
      {
        tasks: [
          { id: "t1", title: "Score", instructions: "Score task: show the score in js/hud.js" },
          { id: "t2", title: "Two", instructions: "Do two" },
        ],
      },
      ctx(),
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]).toMatchObject({ id: "t1", status: "needs_input", question: QUESTION });
    expect(rows[0]?.notes).toContain(WORKER_NEEDS_INPUT_NOTE);
    expect(rows[1]).toMatchObject({ id: "t2", status: "ok" });
    expect(rows[1]).not.toHaveProperty("question");
    expect(result.summary).toContain("needs_input");
    expect(result.summary).toContain(`question: ${QUESTION}`);
    expect(result.summary).toContain("send this task out again with the answer");
  });

  it("re-sent with the answer in its instructions, the worker gets it and finishes", async () => {
    const briefs: string[] = [];
    const tool = buildFusionDelegateTool(deps(scripted(briefs)));
    const first = await tool.run(
      { tasks: [{ id: "t1", title: "Score", instructions: "Score task: show the score in js/hud.js" }] },
      ctx(),
    );
    const asked = (first.details.tasks as WorkerTaskResult[])[0]!;
    expect(asked.status).toBe("needs_input");
    // The orchestrator's next round: the same task, the answer in its brief.
    const second = await tool.run(
      {
        tasks: [
          {
            id: "t1",
            title: "Score",
            instructions: `Score task: show the score in js/hud.js\nYou asked: ${asked.question}\nANSWER: the best lap`,
          },
        ],
      },
      ctx(),
    );
    expect(briefs).toHaveLength(2);
    expect(briefs[1]).toContain("ANSWER: the best lap");
    expect(briefs[1]).toContain(QUESTION);
    const row = (second.details.tasks as WorkerTaskResult[])[0]!;
    expect(row.status).toBe("ok");
    expect(row).not.toHaveProperty("question");
  });

  it("does not read a question from a worker that failed", async () => {
    const tool = buildFusionDelegateTool(
      deps(async (_session, _message, options) => {
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: `NEEDS_INPUT: ${QUESTION}` },
        });
        return turnResult({ reason: "failed" });
      }),
    );
    const result = await tool.run(
      { tasks: [{ id: "t1", title: "One", instructions: "Do one" }] },
      ctx(),
    );
    const row = (result.details.tasks as WorkerTaskResult[])[0]!;
    expect(row.status).toBe("failed");
    expect(row).not.toHaveProperty("question");
  });
});

const row = (over: Partial<WorkerTaskResult> = {}): WorkerTaskResult => ({
  id: "t1",
  title: "One",
  status: "needs_input",
  reply: `NEEDS_INPUT: ${QUESTION}`,
  stepCount: 2,
  durationMs: 1000,
  tools: { calls: 1, errors: 0, writes: 0, byTool: {} },
  question: QUESTION,
  ...over,
});

describe("needs_input is not a failure", () => {
  it("resets the breaker's streak like a finished task", () => {
    const breaker = new FanoutFailureBreaker("local-llama", 3);
    const failed = { status: "failed" as const, error: "worker died" };
    breaker.observe(failed);
    breaker.observe(failed);
    breaker.observe({ status: "needs_input" });
    breaker.observe(failed);
    breaker.observe(failed);
    expect(breaker.tripped()).toBeUndefined();
  });

  it("is not turned into failed by a check it could not have passed", () => {
    const [folded] = applyCheckOutcomes(
      [row()],
      [{ task: "t1", ok: false, detail: "node js/hud.js exited 1" } as never],
    );
    expect(folded?.status).toBe("needs_input");
    expect(folded?.checks?.failed).toBe(1);
    expect(folded?.error).toBeUndefined();
  });

  it("did not deliver, so a dependent is warned rather than told it is done", () => {
    expect(UNDELIVERED_STATUSES.has("needs_input")).toBe(true);
  });

  it("counts on the head line and shows the question in the task block", () => {
    const out = formatDelegateOutput([row(), row({ id: "t2", status: "ok", question: undefined, reply: "done" })], 4000);
    expect(out.split("\n")[0]).toContain("1 ok, 1 needs_input");
    expect(out).toContain(`question: ${QUESTION}`);
  });
});
