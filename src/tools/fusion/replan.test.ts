import { describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildFusionDelegateTool, type FusionDelegateDeps } from "./fusion-delegate.js";
import { FusionTurnBudget } from "./turn-budget.js";
import { describeReplan } from "./replan.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "cloud",
    orchestratorModel: "big",
    workerProviderId: "local",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "cloud",
    degraded: null,
    autoReplan: 2,
    ...over,
  };
}

function deps(failing: Set<string>, over: Partial<FusionDelegateDeps> = {}) {
  let minted = 0;
  const ran: string[] = [];
  const d: FusionDelegateDeps = {
    runTurn: async (session) => {
      const taskId = (session.metadata as { fusionWorker: { taskId: string } }).fusionWorker.taskId;
      ran.push(taskId);
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
        reason: failing.has(taskId) ? "failed" : "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {}, fanoutScopes: new FanoutScopeRegistry() },
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
  };
  return { d, ran };
}

const ctx = () => ({ workingDir: "/repo", sessionId: "s-p", stepIndex: 0, signal: new AbortController().signal });

const ORDERED = {
  tasks: [
    { id: "core", title: "Core", instructions: "make core" },
    { id: "ui", title: "UI", instructions: "make ui" },
  ],
  contract: {
    provides: [{ task: "core", kind: "symbol", name: "Core.run", in: "core.js" }],
    requires: [{ task: "ui", name: "Core.run" }],
  },
};

describe("automatic replanning (ATO-941)", () => {
  it("holds a dependent of a failed task and sends both back to the planner", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d, ran } = deps(new Set(["core"]), { turnBudget: budget });
    const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
    expect(ran).toEqual(["core"]);
    const rows = result.details.tasks as Array<{ id: string; status: string; error?: string }>;
    expect(rows[1]).toMatchObject({ id: "ui", status: "cancelled" });
    expect(rows[1]!.error).toMatch(/held for the replan: it depends on core/);
    expect(result.summary).toContain("REPLAN REQUIRED");
    const replan = result.details.replan as { pending: Array<{ id: string; replansLeft: number }> };
    expect(replan.pending.map((t) => t.id)).toEqual(["core", "ui"]);
    expect(replan.pending[0]!.replansLeft).toBe(1);
  });

  it("stops sending a task back once its replans are used", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-p");
    const { d } = deps(new Set(["core"]), { turnBudget: budget });
    const tool = buildFusionDelegateTool(d);
    const one = { tasks: [ORDERED.tasks[0]!] };
    await tool.run(one, ctx());
    await tool.run(one, ctx());
    const third = await tool.run(one, ctx());
    const replan = third.details.replan as { pending: unknown[]; exhausted: Array<{ id: string }> };
    expect(replan.pending).toEqual([]);
    expect(replan.exhausted.map((t) => t.id)).toEqual(["core"]);
    expect(third.summary).toContain("NO REPLANS LEFT (2 used)");
  });

  it("is off by default: dependents run and nothing is sent back", async () => {
    const { d, ran } = deps(new Set(["core"]), { resolveRunMode: () => mode({ autoReplan: undefined }) });
    const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
    expect(ran).toEqual(["core", "ui"]);
    expect(result.details.replan).toBeUndefined();
    expect(result.summary).not.toContain("REPLAN");
  });

  it("does not send back an ok task or one the person cancelled", () => {
    const report = describeReplan(
      [
        { id: "a", status: "ok" } as never,
        { id: "b", status: "cancelled", error: "stopped" } as never,
        { id: "c", status: "timeout" } as never,
      ],
      () => 1,
      2,
    );
    expect(report.pending.map((t) => t.id)).toEqual(["c"]);
  });
});
