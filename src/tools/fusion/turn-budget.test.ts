import { describe, expect, it } from "vitest";
import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import { FusionTurnBudget } from "./turn-budget.js";
import { fanoutSpend, WorkerRunCollector } from "./worker-result.js";

const logger = new StructuredLogger({ level: "error", sinks: [] });

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    stored: "fusion",
    effective: "fusion",
    orchestratorProviderId: "openrouter",
    orchestratorModel: "big",
    workerProviderId: "cloud-worker",
    workerModel: "small",
    workers: 1,
    workersPinned: true,
    workerMaxSteps: 7,
    workerTimeoutMs: 60_000,
    primaryProviderId: "openrouter",
    degraded: null,
    ...over,
  };
}

const ctx = (): ToolContext => ({
  workingDir: "/repo",
  sessionId: "s-parent",
  stepIndex: 0,
  signal: new AbortController().signal,
});

function completedEvent(promptTokens: number, cachedTokens?: number) {
  return {
    type: "llm_event",
    event: {
      type: "llm_completed",
      completion: {
        content: "",
        reasoningContent: "",
        stop: true,
        truncated: false,
        cacheHitTokens: 0,
        slotId: 0,
        modelId: "small",
        usage: {
          promptTokens,
          completionTokens: 0,
          totalTokens: promptTokens,
          ...(cachedTokens === undefined ? {} : { cachedTokens }),
        },
      },
    },
  } as never;
}

function deps(over: Partial<FusionDelegateDeps>): FusionDelegateDeps & { turns: number } {
  let minted = 0;
  const d = {
    turns: 0,
    runTurn: async (_s: unknown, _m: string, options: Parameters<FusionDelegateDeps["runTurn"]>[2]) => {
      d.turns += 1;
      // $1 per task at the pricing below.
      options.eventHook?.(completedEvent(1_000_000));
      return {
        session: createEmptySessionState({ id: "s-w", workingDir: "/repo" }),
        reason: "reply",
        stepCount: 1,
      } as RunTurnResult;
    },
    createEphemeralSession: (meta: never) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...(meta as object) } },
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
    resolveRunMode: () => mode(),
    workerSupportsSlotAffinity: () => false,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    resolveWorkerPricing: () => ({ input: 1, output: 4, cacheRead: 0.1 }),
    ...over,
  } as FusionDelegateDeps & { turns: number };
  return d;
}

const THREE = [1, 2, 3].map((i) => ({
  id: `t${i}`,
  title: `T${i}`,
  instructions: `do ${i}`,
}));

describe("honest worker spend (ATO-918)", () => {
  it("keeps cached tokens through the per-step sum", () => {
    const c = new WorkerRunCollector();
    c.observe(completedEvent(100_000, 80_000));
    c.observe(completedEvent(200_000, 180_000));
    const row = c.finish({ id: "a", title: "A", reason: "reply", stepCount: 2, durationMs: 1 });
    expect(row.usage?.cachedTokens).toBe(260_000);
  });

  it("prices cached prompt tokens at the cacheRead rate", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, cachedTokens: 900_000 };
    const spend = fanoutSpend(
      [{ usage } as never],
      { input: 1, output: 4, cacheRead: 0.1 },
      "m",
    );
    // 100k uncached at $1/M + 900k cached at $0.1/M, not $1.00.
    expect(spend.usd).toBeCloseTo(0.19);
    expect(spend.cachedTokens).toBe(900_000);
  });
});

describe("per-turn caps (ATO-947)", () => {
  it("changes nothing when no cap is set", async () => {
    const d = deps({});
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(3);
    expect(result.details.turnBudget).toBeUndefined();
    expect(result.summary).not.toContain("Stopped:");
  });

  it("refuses a new delegation once the turn's spend is over the cap", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({
      resolveRunMode: () => mode({ turnBudgetUsd: 2 }),
      turnBudget: budget,
      orchestratorTurnSpendUsd: () => 2.5,
    });
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(0);
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("turn-budget");
    expect(result.summary).toMatch(/spend cap for this turn is reached: \$2\.50/);
    expect(result.summary).toMatch(/reply to the person now/);
  });

  it("starts no more workers once the workers' own spend reaches the cap", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({
      resolveRunMode: () => mode({ turnBudgetUsd: 1.5 }),
      turnBudget: budget,
    });
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    // $1 each: the second worker crosses $1.50, the third never starts.
    expect(d.turns).toBe(2);
    const rows = result.details.tasks as Array<{ id: string; status: string; error?: string }>;
    expect(rows[2]).toMatchObject({ id: "t3", status: "cancelled" });
    expect(rows[2]!.error).toMatch(/^not started: the spend cap/);
    expect(result.summary).toContain("Stopped: the spend cap for this turn is reached");
    expect(result.details.turnBudget).toMatchObject({ kind: "usd" });
  });

  it("refuses once the turn's time cap has passed", async () => {
    let now = 0;
    const budget = new FusionTurnBudget(() => now);
    budget.begin("s-parent");
    now = 31 * 60_000;
    const d = deps({
      resolveRunMode: () => mode({ turnTimeBudgetMs: 30 * 60_000 }),
      turnBudget: budget,
    });
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(0);
    expect(result.summary).toMatch(/time cap for this turn is reached: 31 min of the 30 min/);
  });

  it("starts each turn from zero", () => {
    const budget = new FusionTurnBudget();
    budget.begin("s");
    budget.addWorkerSpend("s", 5);
    expect(budget.check("s", { usd: 4 })).toBeDefined();
    budget.begin("s");
    expect(budget.check("s", { usd: 4 })).toBeUndefined();
  });
});

describe("turn cap config (ATO-947)", () => {
  it("parses both caps and rejects a negative one", async () => {
    const { parseLlmRunModeConfig } = await import("../../config/llm-run-mode-config.js");
    const parsed = parseLlmRunModeConfig(
      { fusion: { turnBudgetUsd: 2.5, turnTimeBudgetMs: 1_800_000 } },
      [],
      "llm.runMode",
    );
    expect(parsed.fusion).toMatchObject({ turnBudgetUsd: 2.5, turnTimeBudgetMs: 1_800_000 });
    expect(() =>
      parseLlmRunModeConfig({ fusion: { turnBudgetUsd: -1 } }, [], "llm.runMode"),
    ).toThrow(/turnBudgetUsd/);
  });
});

describe("orchestrator spend on turns outside runTurn (ATO-947)", () => {
  it("counts the planner's spend as a delta from the meter's reading at turn start", async () => {
    const { TurnUsageMeter } = await import("../../analytics/turn-usage-meter.js");
    const meter = new TurnUsageMeter();
    const budget = new FusionTurnBudget();
    const pricing = { input: 1_000_000, output: 0 } as never;
    const spend = (usd: number) =>
      meter.record({
        sessionId: "s",
        usage: { promptTokens: usd, completionTokens: 0, totalTokens: usd },
        model: { pricing } as never,
      });
    // Turn 1 on the sidecar: no runTurn bucket, so the turn start opens one.
    meter.ensureOpen("s");
    budget.begin("s", meter.peekCostUsd("s") ?? 0);
    spend(3);
    expect(budget.check("s", { usd: 2 }, meter.peekCostUsd("s"))?.kind).toBe("usd");
    // Turn 2: the bucket is still open with $3 in it; only new spend counts.
    meter.ensureOpen("s");
    budget.begin("s", meter.peekCostUsd("s") ?? 0);
    spend(1);
    expect(budget.check("s", { usd: 2 }, meter.peekCostUsd("s"))).toBeUndefined();
  });
});

describe("FusionTurnBudget — count caps (ATO-1406)", () => {
  it("refuses a round past maxRoundsPerTurn and tasks past maxTasksPerTurn", () => {
    const budget = new FusionTurnBudget();
    budget.begin("s");
    expect(budget.checkCounts("s", { rounds: 2, tasks: 10 }, 4)).toBeUndefined();
    budget.noteRound("s", 4);
    budget.noteRound("s", 4);
    expect(budget.checkCounts("s", { rounds: 2 }, 1)?.kind).toBe("rounds");
    expect(budget.checkCounts("s", { tasks: 10 }, 3)?.kind).toBe("tasks");
    expect(budget.checkCounts("s", { tasks: 10 }, 2)).toBeUndefined();
    expect(budget.checkCounts("s", {}, 100)).toBeUndefined();
  });

  it("starts the counts and the trips from zero at each turn", () => {
    const budget = new FusionTurnBudget();
    budget.begin("s");
    budget.noteRound("s", 5);
    budget.noteTrip("s", {
      signature: "blocker:tool-protocol",
      blocker: true,
      label: "x",
      count: 1,
      providerId: "codex",
    });
    budget.begin("s");
    expect(budget.counts("s")).toEqual({ rounds: 0, tasks: 0 });
    expect(budget.trips("s")).toEqual([]);
  });
});

describe("failure breaker in fusion.delegate (ATO-1406)", () => {
  const protocolFail = (d: { turns: number }) => async () => {
    d.turns += 1;
    throw new Error("invalid tool-call JSON: Unexpected token < in JSON at position 0");
  };

  it("stops the fan-out after the first blocker and says why", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({ turnBudget: budget });
    d.runTurn = protocolFail(d) as never;
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    // One worker (width 1): the first fails on the protocol, the rest never start.
    expect(d.turns).toBe(1);
    const rows = result.details.tasks as Array<{ status: string; error?: string }>;
    expect(rows.map((r) => r.status)).toEqual(["failed", "cancelled", "cancelled"]);
    expect(rows[1]!.error).toMatch(/^not started: the fan-out was stopped because/);
    expect(result.summary).toContain("tool-call protocol");
    expect(result.summary).toMatch(/Do not re-send these tasks with the same approach/);
  });

  it("refuses the next round on the same leg in the same turn, and allows it next turn", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({ turnBudget: budget });
    d.runTurn = protocolFail(d) as never;
    const tool = buildFusionDelegateTool(d);
    await tool.run({ tasks: THREE }, ctx());
    const again = await tool.run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(1);
    expect(again.status).toBe("error");
    expect(again.details.reason).toBe("failure-breaker");
    expect(again.summary).toMatch(/fusion.delegate did not run: earlier this turn/);
    budget.begin("s-parent");
    await tool.run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(2);
  });

  it("stops after three identical ordinary failures, not before", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({ turnBudget: budget });
    d.runTurn = (async () => {
      d.turns += 1;
      throw new Error(`worker died after ${d.turns} steps`);
    }) as never;
    const four = [...THREE, { id: "t4", title: "T4", instructions: "do 4" }];
    const result = await buildFusionDelegateTool(d).run({ tasks: four }, ctx());
    expect(d.turns).toBe(3);
    const rows = result.details.tasks as Array<{ status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "failed", "cancelled"]);
    expect(result.summary).toContain("3 workers in a row failed with the same error");
  });

  it("keeps going when failures differ", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({ turnBudget: budget });
    const errors = ["disk full", "worker died", "network is down"];
    d.runTurn = (async () => {
      d.turns += 1;
      throw new Error(errors[d.turns - 1] ?? "x");
    }) as never;
    await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(3);
  });
});

describe("round and task caps in fusion.delegate (ATO-1406)", () => {
  it("refuses a round past maxRoundsPerTurn before anything runs", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({
      turnBudget: budget,
      resolveRunMode: () => mode({ maxRoundsPerTurn: 2 }),
    });
    const tool = buildFusionDelegateTool(d);
    await tool.run({ tasks: [THREE[0]!] }, ctx());
    await tool.run({ tasks: [THREE[1]!] }, ctx());
    const third = await tool.run({ tasks: [THREE[2]!] }, ctx());
    expect(d.turns).toBe(2);
    expect(third.status).toBe("error");
    expect(third.details).toMatchObject({ reason: "turn-count", kind: "rounds" });
    expect(third.summary).toMatch(/maxRoundsPerTurn allows \(2\)/);
  });

  it("refuses a round whose tasks would pass maxTasksPerTurn", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({
      turnBudget: budget,
      resolveRunMode: () => mode({ maxTasksPerTurn: 4 }),
    });
    const tool = buildFusionDelegateTool(d);
    await tool.run({ tasks: THREE }, ctx());
    const next = await tool.run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(3);
    expect(next.details).toMatchObject({ reason: "turn-count", kind: "tasks" });
  });

  it("names the round and the task count on the approval line", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const reasons: string[] = [];
    const d = deps({
      turnBudget: budget,
      approvalRequired: true,
      resolveRunMode: () => mode({ maxRoundsPerTurn: 6, maxTasksPerTurn: 24 }),
      approvals: {
        setSessionPolicy: () => {},
        clearSessionPolicy: () => {},
        fanoutScopes: new FanoutScopeRegistry(),
        request: async (req: { reason?: string }) => {
          reasons.push(req.reason ?? "");
          return { approved: true };
        },
      } as never,
    });
    await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(reasons[0]).toContain("(round 1 of at most 6 this turn, 3 tasks of at most 24 in all)");
  });
});

describe("auto-replan after a breaker trip (ATO-1406)", () => {
  it("does not hold the planner to a replan once the breaker stopped the fan-out", async () => {
    const budget = new FusionTurnBudget();
    budget.begin("s-parent");
    const d = deps({
      turnBudget: budget,
      resolveRunMode: () => mode({ autoReplan: 2 }),
    });
    d.runTurn = (async () => {
      d.turns += 1;
      throw new Error("invalid tool-call JSON: Unexpected token");
    }) as never;
    const result = await buildFusionDelegateTool(d).run({ tasks: THREE }, ctx());
    expect(d.turns).toBe(1);
    expect(result.details.replan).toBeUndefined();
  });
});
