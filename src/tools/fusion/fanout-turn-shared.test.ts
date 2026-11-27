import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  createFusionWorkerSession,
  FUSION_WORKER_ID_PREFIX,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSubagentRunTool, type SubagentRunDeps } from "../subagent/index.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";

/**
 * One turn, `fusion.delegate` and `subagent.run` on the same session in
 * auto mode (ATO-1759). The two share the gate's turn state: the
 * standing answer and the note that a quiet fan-out's worker was refused
 * a command. `subagent.run` used to drop that state whenever it had not
 * given the answer itself, so the next fan-out of the turn went out
 * quiet again and its worker was refused the same command. The state is
 * now tied to the turn, and both tools read the same decision.
 */

const logger = new StructuredLogger({ level: "error", sinks: [] });
const SESSION = "s-parent";

function gateAt(level: 2, declineSubagent: () => boolean): {
  gate: ApprovalGate;
  prompts: ApprovalRequest[];
} {
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level,
    emit: (req) => {
      prompts.push(req);
      const approved = !(req.tool === "subagent.run" && declineSubagent());
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved }));
    },
  });
  return { gate, prompts };
}

const done = (): RunTurnResult => ({
  session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
  reason: "reply",
  stepCount: 1,
});

/** What a worker asked the gate, and what it got. */
interface WorkerAsk {
  category: "shell" | "shell_dangerous";
  approved: boolean;
  scope: readonly string[];
}

function fusionTool(
  gate: ApprovalGate,
  asks: WorkerAsk[],
  wants: () => Array<WorkerAsk["category"]>,
) {
  let minted = 0;
  const deps: FusionDelegateDeps = {
    runTurn: async (session: SessionState) => {
      for (const category of wants()) {
        const verdict = await gate.request({
          sessionId: session.id,
          tool: "os.shell.run",
          category,
          reason: category === "shell" ? "npm test" : "rm -rf build",
        });
        asks.push({
          category,
          approved: verdict.approved,
          scope: gate.fanoutScopes.scopeFor(session.id),
        });
      }
      return done();
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: gate,
    approvalRequired: true,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () =>
      ({
        stored: "fusion",
        effective: "fusion",
        orchestratorProviderId: "openrouter",
        orchestratorModel: "big",
        workerProviderId: "local-llama",
        workerModel: "small",
        workers: 1,
        workersPinned: true,
        workerMaxSteps: 7,
        workerTimeoutMs: 60_000,
        primaryProviderId: "openrouter",
        degraded: null,
      }) as ResolvedRunMode,
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
  };
  return buildFusionDelegateTool(deps);
}

/**
 * `subagent.run` refuses while Fusion is effective, so in one turn it
 * runs next to `fusion.delegate` only after the run mode changed
 * mid-turn; its own resolver says "local" here.
 */
function subagentTool(gate: ApprovalGate) {
  const deps: SubagentRunDeps = {
    runTurn: async () => done(),
    createEphemeralSession: (meta: FusionWorkerMeta, dir?: string) =>
      createFusionWorkerSession({ workingDir: dir ?? "/repo", meta }),
    approvals: gate,
    approvalRequired: true,
    emitEvent: () => {},
    workingDir: "/repo",
    resolveRunMode: () =>
      ({
        effective: "local",
        workerMaxSteps: 6,
        workerTimeoutMs: 60_000,
        cloudWorkers: 4,
      }) as unknown as ResolvedRunMode,
    resolveSessionLeg: () => ({ providerId: "session-provider", model: "session-model" }),
    workerSupportsSlotAffinity: () => false,
    outputCharCap: 8_000,
  };
  return buildSubagentRunTool(deps);
}

const ctx = (turnId: string, stepIndex: number): ToolContext => ({
  workingDir: "/repo",
  sessionId: SESSION,
  stepIndex,
  turnId,
  signal: new AbortController().signal,
});

const FANOUT = { tasks: [{ id: "t1", title: "One", instructions: "Write /repo/src/a.js" }] };
const SUBAGENT_CALL = {
  tasks: [{ id: "fix", instructions: "Fix src/b.js.", files: ["src/b.js"] }],
};

describe("fusion.delegate and subagent.run share one turn's approval decision (ATO-1759)", () => {
  it("keeps the refused command note through a subagent call, so the next fan-out asks", async () => {
    const { gate, prompts } = gateAt(2, () => true);
    const asks: WorkerAsk[] = [];
    let wants: Array<WorkerAsk["category"]> = ["shell"];
    const delegate = fusionTool(gate, asks, () => wants);
    const subagent = subagentTool(gate);

    // A quiet fan-out in the folder: its worker is refused the command.
    await delegate.run(FANOUT, ctx("turn-1", 0));
    expect(prompts).toHaveLength(0);
    expect(asks).toEqual([{ category: "shell", approved: false, scope: [] }]);

    // The subagent asks for its files and the person says no.
    const refused = await subagent.run(SUBAGENT_CALL, ctx("turn-1", 1));
    expect(refused.status).toBe("error");
    expect(prompts.map((p) => p.tool)).toEqual(["subagent.run"]);

    // Same turn: the fan-out asks once, as after any refused command.
    // Without the fix the subagent call dropped the note and this one
    // went out quiet, and its worker was refused `npm test` again.
    wants = ["shell"];
    await delegate.run(FANOUT, ctx("turn-1", 2));
    expect(prompts.map((p) => [p.tool, p.category])).toEqual([
      ["subagent.run", "fusion_fanout"],
      ["fusion.delegate", "fusion_fanout"],
    ]);
    // That yes is the fan-out scope `os.shell.run` reads as the
    // operator's word for ordinary commands in the folder.
    expect(asks[1]?.scope).toEqual(["/repo"]);
  });

  it("lets the person's one yes stand for both tools in the turn, and no further", async () => {
    const { gate, prompts } = gateAt(2, () => false);
    const asks: WorkerAsk[] = [];
    let wants: Array<WorkerAsk["category"]> = ["shell"];
    const delegate = fusionTool(gate, asks, () => wants);
    const subagent = subagentTool(gate);

    await delegate.run(FANOUT, ctx("turn-1", 0)); // quiet, command refused
    wants = [];
    await delegate.run(FANOUT, ctx("turn-1", 1)); // asks: the person says yes
    expect(prompts.map((p) => p.tool)).toEqual(["fusion.delegate"]);

    // The subagent's files lie inside what the person just approved for
    // this turn: the same answer, not a second question. Without the fix
    // the subagent dropped the fan-out's answer and asked again.
    await subagent.run(SUBAGENT_CALL, ctx("turn-1", 2));
    expect(prompts.map((p) => p.tool)).toEqual(["fusion.delegate"]);

    // The fan-out's answer still stands after the subagent call (its
    // workers hold the scope, nobody is asked), and a dangerous command
    // is still refused at the gate: the shared answer admits nothing new.
    wants = ["shell_dangerous"];
    await delegate.run(FANOUT, ctx("turn-1", 3));
    expect(prompts).toHaveLength(1);
    expect(asks.at(-1)).toEqual({ category: "shell_dangerous", approved: false, scope: ["/repo"] });

    // The next turn starts from nothing, though no Fusion turn start
    // cleared the gate: the subagent asks again.
    await subagent.run(SUBAGENT_CALL, ctx("turn-2", 0));
    expect(prompts.map((p) => p.tool)).toEqual(["fusion.delegate", "subagent.run"]);
  });

  it("does not let a fan-out read a subagent's answer from an earlier turn", async () => {
    const { gate, prompts } = gateAt(2, () => false);
    const asks: WorkerAsk[] = [];
    const delegate = fusionTool(gate, asks, () => ["shell"]);
    const subagent = subagentTool(gate);

    // A non-Fusion turn: the person lets subagents write in /repo.
    await subagent.run(SUBAGENT_CALL, ctx("turn-1", 0));
    expect(prompts.map((p) => p.tool)).toEqual(["subagent.run"]);

    // A later turn (no Fusion turn start cleared the gate): the fan-out
    // is decided afresh, quiet under the level, and its worker holds no
    // scope from the old yes.
    await delegate.run(FANOUT, ctx("turn-2", 0));
    expect(prompts).toHaveLength(1);
    expect(asks).toEqual([{ category: "shell", approved: false, scope: [] }]);
  });
});
