import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import { resetConfigCache } from "../../config/index.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import { runChecks as runVerifyChecks } from "../verify/run-verify.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import type { WorkerTaskResult } from "./worker-result.js";

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

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/repo",
    sessionId: "s-parent",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...over,
  };
}

function deps(over: Partial<FusionDelegateDeps> = {}): FusionDelegateDeps {
  let minted = 0;
  return {
    runTurn: async () => turnResult(),
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
    // The documented test seam: exercise the fan-out without a gate.
    approvalRequired: false,
    emitEvent: () => {},
    workingDir: "/repo",
    slotManager: { poolSize: () => 4 },
    resolveRunMode: () => fusionMode(),
    workerSupportsSlotAffinity: () => true,
    warmWorkerBackend: async () => {},
    outputCharCap: 4000,
    logger,
    ...over,
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

const TASKS = [
  { id: "t1", title: "One", instructions: "Do one" },
  { id: "t2", title: "Two", instructions: "Do two" },
];

/** Six independent tasks — more than the fixture's configured `workers` (3). */
function sixTasks(): Array<{
  id: string;
  title: string;
  instructions: string;
}> {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `t${i + 1}`,
    title: `Task ${i + 1}`,
    instructions: `Do ${i + 1}`,
  }));
}

describe("fusion.delegate", () => {
  it("is not readonly and carries its own name", () => {
    const tool = buildFusionDelegateTool(deps());
    expect(tool.name).toBe("fusion.delegate");
    expect(tool.readonly).toBe(false);
  });

  it("refuses when called from inside a worker session", async () => {
    // One level of fan-out. The descriptor is already hidden from a
    // worker's catalog, so this is the hard stop for a model that emits
    // the name anyway — and it must fire before any turn is started.
    const runTurn = vi.fn(async () => turnResult());
    const tool = buildFusionDelegateTool(deps({ runTurn }));
    const result = await tool.run(
      { tasks: TASKS },
      ctx({ sessionId: `${FUSION_WORKER_ID_PREFIX}abc` }),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("not available to a worker");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("refuses when the run mode is no longer effectively fusion", async () => {
    // The operator switching provider by hand leaves fusion on the next
    // read (§"Run modes"). A tool that kept fanning out would spend on a
    // leg the operator just walked away from.
    const runTurn = vi.fn(async () => turnResult());
    const tool = buildFusionDelegateTool(
      deps({
        runTurn,
        resolveRunMode: () => fusionMode({ effective: "cloud" }),
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain('run mode is "cloud"');
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("refuses when fusion is effective but no worker leg resolved", async () => {
    const tool = buildFusionDelegateTool(
      deps({ resolveRunMode: () => fusionMode({ workerProviderId: null }) }),
    );
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("error");
  });

  it("re-resolves the worker leg on every call, never at registration", async () => {
    // The pin the workers run on is spend. A leg captured when the tool
    // was built would keep charging an operator who reconfigured the
    // worker provider mid-session — and this branch registers the tool
    // unconditionally at boot, so "registration time" can now be a run
    // mode that no longer exists.
    let mode = fusionMode();
    const pins: Array<string | undefined> = [];
    const tool = buildFusionDelegateTool(
      deps({
        resolveRunMode: () => mode,
        runTurn: async (_session, _msg, options) => {
          pins.push(options.providerId);
          return turnResult();
        },
      }),
    );
    await tool.run({ tasks: [TASKS[0]!] }, ctx());
    mode = fusionMode({ workerProviderId: "other-llama", workerModel: "tiny" });
    await tool.run({ tasks: [TASKS[0]!] }, ctx());
    expect(pins).toEqual(["local-llama", "other-llama"]);
  });

  it("labels a task that named no title with its humanised id — in the table, the details and the feed", async () => {
    // Every task of one live call lacked `title`; refusing it cost a
    // ~5 tok/s orchestrator four minutes for a label.
    const events: Array<Record<string, unknown>> = [];
    const tool = buildFusionDelegateTool(
      deps({
        emitEvent: (sessionId, event) => events.push({ sessionId, ...event }),
      }),
    );
    const result = await tool.run(
      { tasks: [{ id: "fix_main_sync", instructions: "Fix it." }] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary.split("\n")[1]).toBe(
      "- [fix_main_sync] ok — fix main sync",
    );
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]).toMatchObject({
      id: "fix_main_sync",
      title: "fix main sync",
    });
    expect(
      events.filter((e) => e.role === "worker").map((e) => e.title),
    ).toEqual(["fix main sync", "fix main sync"]);
  });

  it("brackets the fan-out with the orchestrator's own model", async () => {
    // Between these two lines every feed line belongs to a worker on the
    // local leg; the operator can otherwise only guess which model is
    // spending. Both ride the parent session id, like the worker lines.
    const events: Array<Record<string, unknown>> = [];
    const tool = buildFusionDelegateTool(
      deps({
        emitEvent: (sessionId, event) => events.push({ sessionId, ...event }),
      }),
    );
    await tool.run({ tasks: TASKS }, ctx());
    const orchestrator = events.filter((e) => e.role === "orchestrator");
    expect(orchestrator).toMatchObject([
      {
        sessionId: "s-parent",
        phase: "tool",
        model: "big",
        tool: "fusion.delegate",
        title: "2 tasks",
      },
      {
        sessionId: "s-parent",
        phase: "finished",
        model: "big",
        summary: "2/2 ok — merging",
      },
    ]);
    // The workers' own lines name the worker model, not the cloud one.
    expect(
      events
        .filter((e) => e.role === "worker")
        .every((e) => e.model === "small"),
    ).toBe(true);
  });

  it("falls back to the provider id when the resolver has no model label", async () => {
    // `orchestratorModel` / `workerModel` are both nullable. A made-up
    // string here would be attribution the runtime cannot stand behind.
    const events: Array<Record<string, unknown>> = [];
    const tool = buildFusionDelegateTool(
      deps({
        resolveRunMode: () =>
          fusionMode({ orchestratorModel: null, workerModel: null }),
        emitEvent: (sessionId, event) => events.push({ sessionId, ...event }),
      }),
    );
    await tool.run({ tasks: [TASKS[0]!] }, ctx());
    expect(new Set(events.map((e) => e.model))).toEqual(
      new Set(["openrouter", "local-llama"]),
    );
  });

  it("reports invalid args as an error the orchestrator can fix", async () => {
    const tool = buildFusionDelegateTool(deps());
    const result = await tool.run({ tasks: [] }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("at least one task");
  });

  it("warms the worker backend BEFORE it measures the slot pool", async () => {
    // A fusion boot is cloud-active, so the local pool is still sized 1
    // until the deferred `/props` lands inside the warm. Reading first
    // would cap every fan-out at one worker on a fresh runtime.
    const order: string[] = [];
    let pool = 1;
    const tool = buildFusionDelegateTool(
      deps({
        warmWorkerBackend: async () => {
          order.push("warm");
          pool = 4;
        },
        slotManager: {
          poolSize: () => {
            order.push("poolSize");
            return pool;
          },
        },
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(order).toEqual(["warm", "poolSize"]);
    expect(result.details.maxWorkers).toBe(2);
  });

  it("honours a maxWorkers ABOVE the configured `workers`", async () => {
    // `llm.runMode.fusion.workers` is 3 in this fixture and the
    // orchestrator asks for 6: it gets 6, and six turns really do run at
    // once. The model is the party that knows how divisible this job is
    // and what the machine can serve (the `### fusion` block tells it),
    // so an operator-set number in a config file must not veto it — the
    // config value is a default for a call that named nothing.
    let live = 0;
    let peak = 0;
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 8 },
        runTurn: async () => {
          live += 1;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setTimeout(resolve, 1));
          live -= 1;
          return turnResult();
        },
      }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.details.maxWorkers).toBe(6);
    expect(result.details.requestedWorkers).toBe(6);
    expect(peak).toBe(6);
    expect(result.summary).not.toContain("localModels.managed.parallel");
  });

  it("runs one local worker at a time when the call names no width and nothing is pinned", async () => {
    // Slots share one GPU: the benchmark measured two local workers at
    // 2.6-2.9 tok/s each against 6.4 for one, and a fan-out that
    // overflows the shared context loses every worker at once. So a
    // call that named nothing on a slot-affine leg gets one worker
    // unless the operator pinned `runMode.fusion.workers`.
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 8 },
        resolveRunMode: () => fusionMode({ workers: 2, workersPinned: false }),
      }),
    );
    const result = await tool.run({ tasks: sixTasks() }, ctx());
    expect(result.details.maxWorkers).toBe(1);
    expect(result.details.requestedWorkers).toBe(1);
  });

  it("takes a pinned `runMode.fusion.workers` as the default width on a local leg", async () => {
    // `workers: 3` is pinned in this fixture; six tasks on eight slots
    // run three at a time.
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 8 } }),
    );
    const result = await tool.run({ tasks: sixTasks() }, ctx());
    expect(result.details.maxWorkers).toBe(3);
    expect(result.details.requestedWorkers).toBe(3);
  });

  it("takes the configured default on a cloud leg, pinned or not", async () => {
    const tool = buildFusionDelegateTool(
      deps({
        workerSupportsSlotAffinity: () => false,
        resolveRunMode: () => fusionMode({ workers: 4, workersPinned: false }),
      }),
    );
    const result = await tool.run({ tasks: sixTasks() }, ctx());
    expect(result.details.maxWorkers).toBe(4);
  });

  it("honours an explicit maxWorkers on a local leg up to the pool", async () => {
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 4 },
        resolveRunMode: () => fusionMode({ workers: 2, workersPinned: false }),
      }),
    );
    expect(
      (await tool.run({ tasks: sixTasks(), maxWorkers: 3 }, ctx())).details
        .maxWorkers,
    ).toBe(3);
    expect(
      (await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx())).details
        .maxWorkers,
    ).toBe(4);
  });

  it("never runs more workers than there are tasks", async () => {
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 8 } }),
    );
    expect(
      (await tool.run({ tasks: TASKS, maxWorkers: 8 }, ctx())).details
        .maxWorkers,
    ).toBe(2);
  });

  it("runs an over-ambitious maxWorkers as wide as it can, instead of refusing", async () => {
    // A number wider than the machine can go used to be a validation
    // error the orchestrator had to notice and retry. It is a decision
    // the tool can simply honour up to what exists.
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 8 } }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 40 }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.maxWorkers).toBe(6);
    expect(result.details.requestedWorkers).toBe(40);
  });

  it("still bounds the model's width by the slot pool on a slot-affine leg", async () => {
    // The one bound that survives: more workers than slots do not run,
    // they queue on the server and evict each other's KV cache.
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 2 } }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.details.maxWorkers).toBe(2);
    expect(result.details.slotPoolSize).toBe(2);
  });

  it("ignores the slot pool for a worker leg without slot affinity", async () => {
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 1 },
        workerSupportsSlotAffinity: () => false,
        resolveRunMode: () => fusionMode({ cloudWorkers: 8 }),
      }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.details.maxWorkers).toBe(6);
    expect(result.details.slotPoolSize).toBeUndefined();
    expect(result.summary).not.toContain("localModels.managed.parallel");
    expect(result.summary).not.toContain("cloudWorkers");
  });

  it("hands the worker reasoning and cap to every worker turn, and prices the fan-out (F20)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async (_session, _message, options) => {
          seen.push({ ...options });
          options.eventHook?.({
            type: "llm_event",
            event: {
              type: "llm_completed",
              completion: {
                content: "",
                reasoningContent: "",
                stop: true,
                truncated: false,
                timing: {
                  promptMs: 1,
                  predictedMs: 1,
                  promptTokens: 1,
                  predictedTokens: 1,
                },
                cacheHitTokens: 0,
                slotId: 0,
                modelId: "small",
                usage: {
                  promptTokens: 1_000_000,
                  completionTokens: 250_000,
                  totalTokens: 1_250_000,
                },
              },
            },
          });
          return turnResult();
        },
        resolveRunMode: () =>
          fusionMode({ workerReasoning: "low", workerMaxOutputTokens: 12_000 }),
        resolveWorkerPricing: (providerId, modelId) =>
          providerId === "local-llama" && modelId === "small"
            ? { input: 1, output: 4 }
            : undefined,
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      reasoningEffort: "low",
      maxOutputTokens: 12_000,
    });
    expect(result.summary).toContain(
      "cloud spend $4.00 on small (2,000,000 in / 500,000 out)",
    );
    expect(result.details.workerSpendUsd).toBeCloseTo(4);
  });

  it("sends no reasoning or cap and no spend line when nothing is configured or priced (F20)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async (_session, _message, options) => {
          seen.push({ ...options });
          return turnResult();
        },
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(seen[0]).not.toHaveProperty("reasoningEffort");
    expect(seen[0]).not.toHaveProperty("maxOutputTokens");
    expect(result.summary).not.toContain("cloud spend");
    expect(result.details).not.toHaveProperty("workerSpendUsd");
  });

  /**
   * The local pool is divided by `workerReplyAllowance` (16 384), not by
   * the raw `completionMaxTokens`. A cap raised past it (96k for long
   * single-stream runs) is sent as the local workers' own, so no worker
   * writes past its share of the shared context; a cloud leg has no pool
   * and is not capped.
   */
  it("caps local workers at the reply allowance the pool was sized for", async () => {
    const before = process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS;
    process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = "96000";
    resetConfigCache();
    try {
      const seen: Array<Record<string, unknown>> = [];
      const run = async (over: Partial<FusionDelegateDeps>) => {
        seen.length = 0;
        await buildFusionDelegateTool(
          deps({
            runTurn: async (_session, _message, options) => {
              seen.push({ ...options });
              return turnResult();
            },
            ...over,
          }),
        ).run({ tasks: TASKS }, ctx());
        return seen[0];
      };
      expect(await run({})).toMatchObject({ maxOutputTokens: 16_384 });
      expect(
        await run({ workerSupportsSlotAffinity: () => false }),
      ).not.toHaveProperty("maxOutputTokens");
      // The operator's own worker cap still wins.
      expect(
        await run({
          resolveRunMode: () => fusionMode({ workerMaxOutputTokens: 40_000 }),
        }),
      ).toMatchObject({ maxOutputTokens: 40_000 });
    } finally {
      if (before === undefined) delete process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS;
      else process.env.ATOMIC_AGENT_LLAMA_MAX_TOKENS = before;
      resetConfigCache();
    }
  });

  it("sizes a local worker's time limit from the measured speed, a cloud one from the ceiling (F19)", async () => {
    const limits: Array<number | undefined> = [];
    const capture = (over: Partial<FusionDelegateDeps>) =>
      buildFusionDelegateTool(
        deps({
          runTurn: async (_s, _m, options) => {
            limits.push(options.taskMaxDurationMs);
            return turnResult();
          },
          resolveRunMode: () => fusionMode({ workerTimeoutMs: 2_700_000 }),
          localTokensPerSecond: () => 10,
          ...over,
        }),
      );
    const task = {
      id: "t1",
      title: "One",
      instructions: "Do one",
      files: ["a.js", "b.js"],
    };
    // What the LOOP is handed is the worker's budget plus its queue
    // allowance (a third): the loop's clock starts at turn start, which
    // includes the wait for a slot, while the worker's own clock starts
    // at its first token.
    const withQueue = (ms: number): number => ms + Math.floor(ms / 3);
    await capture({}).run({ tasks: [task] }, ctx());
    expect(limits[0]).toBeGreaterThanOrEqual(withQueue(600_000));
    expect(limits[0]).toBeLessThan(withQueue(2_700_000));
    await capture({ workerSupportsSlotAffinity: () => false }).run(
      { tasks: [task] },
      ctx(),
    );
    expect(limits[1]).toBe(withQueue(2_700_000));
    await capture({ localTokensPerSecond: () => null }).run(
      { tasks: [task] },
      ctx(),
    );
    expect(limits[2]).toBe(withQueue(2_700_000));
  });

  it("clamps a cloud fan-out to cloudWorkers and says so (F21)", async () => {
    // A cloud leg has no slot pool, so before this the width was whatever
    // the model asked for — three workers from a one-worker config, and
    // no ceiling on forty. Default cap 4; the note names the knob.
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 1 },
        workerSupportsSlotAffinity: () => false,
      }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.details.maxWorkers).toBe(4);
    expect(result.details.requestedWorkers).toBe(6);
    expect(result.summary).toContain(
      "maxWorkers 6 was clamped to 4, the cloud worker cap (`llm.runMode.fusion.cloudWorkers`)",
    );
    // A call that names nothing keeps `workers` as its default, under the cap.
    const quiet = await tool.run({ tasks: sixTasks() }, ctx());
    expect(quiet.details.maxWorkers).toBe(3);
    expect(quiet.summary).not.toContain("cloudWorkers");
  });

  it("names both numbers and the knob when the pool is the binding constraint", async () => {
    // The orchestrator is the party that can adapt, so the note has to
    // reach its tool result and carry all three facts: what was wanted,
    // what actually ran at once, and the key that moves the second one.
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 2 } }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.summary).toContain("6 workers' worth of work was sent");
    expect(result.summary).toContain("2 request slots");
    expect(result.summary).toContain("only 2 ran at a time");
    // The knob is still named, but as where the number comes from
    // rather than as something to go and raise: it is `"auto"` now.
    expect(result.summary).toContain("localModels.managed.parallel");
    expect(result.summary).toContain("comes from the machine");
  });

  it("says nothing about the pool when it was not what held the fan-out down", async () => {
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 1 } }),
    );
    // One task on a one-slot server: the task count is the constraint,
    // and naming `parallel` would send the operator after the wrong knob.
    const solo = await tool.run({ tasks: [TASKS[0]!] }, ctx());
    expect(solo.summary).not.toContain("localModels.managed.parallel");
    // Two tasks on the same server: the pool really did serialise them.
    const pair = await tool.run({ tasks: TASKS }, ctx());
    expect(pair.summary).toContain("localModels.managed.parallel");
    expect(pair.summary).toContain("1 request slot,");
  });

  it("hands the parent turn's original request to every worker brief", async () => {
    const briefs: string[] = [];
    const asked: string[] = [];
    const tool = buildFusionDelegateTool(
      deps({
        resolveOriginalRequest: (sessionId) => {
          asked.push(sessionId);
          return "Build the whole snake game";
        },
        runTurn: async (_session, userMessage) => {
          briefs.push(userMessage);
          return turnResult();
        },
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("ok");
    expect(asked).toEqual(["s-parent"]);
    expect(briefs).toHaveLength(2);
    for (const brief of briefs) {
      expect(brief).toContain("ORIGINAL REQUEST — context only");
      expect(brief).toContain("Build the whole snake game");
    }
  });

  it("stays status:ok with partial results when workers fail", async () => {
    // An orchestrator handed a bare error learns nothing about which
    // parts survived, and partial results are the value of a fan-out.
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async (session) =>
          session.id.endsWith("1")
            ? Promise.reject(new Error("worker died"))
            : turnResult(),
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.outcome).toBe("partial");
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(result.summary.split("\n")[0]).toBe("2 tasks: 1 ok, 1 failed");
    expect(result.summary).toContain("[t1] failed");
    expect(result.summary).toContain("[t2] ok");
  });

  it("reports all_ok when every task delivered", async () => {
    const result = await buildFusionDelegateTool(deps()).run(
      { tasks: TASKS },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.details.outcome).toBe("all_ok");
  });

  it("carries a worker's replaced input into the head line, the row and details.tasks (F43)", async () => {
    // Live, 2026-09-15: the worker's write result warned that it had
    // replaced the user's 2,401-row `sales.csv`; the orchestrator saw
    // the warning only inside the worker's prose block and merged.
    const replaced = {
      path: "/repo/sales.csv",
      display: "sales.csv",
      bytesBefore: 60_000,
      linesBefore: 2401,
      linesAfter: 9,
      shrunk: true,
      headerChanged: false,
      saved: "saved",
      copy: "1-sales.csv",
    };
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async (session, _message, options) => {
          if (session.id.endsWith("1")) {
            options.eventHook?.({
              type: "llm_event",
              event: {
                type: "tool_call_executed",
                result: {
                  tool: "os.fs.write",
                  status: "ok",
                  summary:
                    "⚠ replaced the user's file `sales.csv` (2,401 lines → 9); …",
                  details: { replaced },
                  truncated: false,
                },
                batchIndex: 0,
                batchSize: 1,
              },
            });
          }
          options.eventHook?.({
            type: "llm_event",
            event: { type: "assistant_reply", text: "done" },
          });
          return turnResult();
        },
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("ok");
    expect(result.details.outcome).toBe("all_ok");
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]?.replacedInputs).toEqual([
      {
        path: "sales.csv",
        tool: "os.fs.write",
        bytesBefore: 60_000,
        linesBefore: 2401,
        linesAfter: 9,
        headerChanged: false,
        saved: "saved",
      },
    ]);
    expect(rows[1]?.replacedInputs).toBeUndefined();
    const lines = result.summary.split("\n");
    expect(lines[0]).toBe("2 tasks: 2 ok — 1 replaced input");
    expect(lines[1]).toBe(
      "- [t1] ok — One — replaced the user's file sales.csv (2,401 → 9 lines)",
    );
    expect(lines[2]).toBe("- [t2] ok — Two");
  });

  it("is status:error only when every task failed — the per-task rows still come back", async () => {
    // A fan-out where every worker died used to return `ok`; an
    // orchestrator reading the status merged nothing as something.
    const tool = buildFusionDelegateTool(
      deps({ runTurn: async () => Promise.reject(new Error("worker died")) }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.status).toBe("error");
    expect(result.details.outcome).toBe("all_failed");
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(result.summary).toContain("2 tasks: 2 failed");
    expect(result.summary).toContain("[t1] failed");
    expect(result.summary).toContain("[t2] failed");
  });

  it("survives an aborted orchestrator turn without throwing, and reports it as every task cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = buildFusionDelegateTool(
      deps({
        runTurn: async () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        },
      }),
    );
    const result = await tool.run(
      { tasks: TASKS },
      ctx({ signal: controller.signal }),
    );
    // Nothing was delivered, so the call itself is an error — but a
    // readable one, with the rows.
    expect(result.status).toBe("error");
    expect(result.details.outcome).toBe("all_failed");
    expect(
      (result.details.tasks as WorkerTaskResult[]).every(
        (r) => r.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("does not fail the call when warming the backend throws", async () => {
    const tool = buildFusionDelegateTool(
      deps({
        warmWorkerBackend: async () => {
          throw new Error("llama-server is down");
        },
      }),
    );
    expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
  });
  it("asks the operator once per turn, not once per fan-out", async () => {
    // The operator's complaint, in one test: a turn that reviews and
    // re-delegates used to raise the same question on every pass.
    const asked: Array<{ category: string; resources?: readonly string[] }> =
      [];
    const scopes = new FanoutScopeRegistry();
    const d = deps({
      approvalRequired: true,
      approvals: {
        setSessionPolicy: () => {},
        clearSessionPolicy: () => {},
        fanoutScopes: scopes,
        request: async (req: {
          category: string;
          affectedResources?: readonly string[];
        }) => {
          asked.push({
            category: req.category,
            ...(req.affectedResources
              ? { resources: req.affectedResources }
              : {}),
          });
          return { approved: true };
        },
      } as unknown as FusionDelegateDeps["approvals"],
    });
    const tool = buildFusionDelegateTool(d);
    const tasks = [
      { id: "t1", title: "One", instructions: "Write /repo/src/a.js" },
    ];
    const first = await tool.run({ tasks }, ctx());
    expect(first.status).not.toBe("error");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.category).toBe("fusion_fanout");

    // The review pass: same turn, same directory, no second question.
    const second = await tool.run(
      {
        tasks: [{ id: "t2", title: "Two", instructions: "Fix /repo/src/a.js" }],
      },
      ctx(),
    );
    expect(second.status).not.toBe("error");
    expect(asked).toHaveLength(1);
  });

  describe("with a contract", () => {
    const CONTRACT = {
      owners: { "js/ship.js": "t1", "index.html": "t2" },
      provides: [
        { task: "t1", kind: "symbol", name: "HD.Ship", in: "js/ship.js" },
        { task: "t1", kind: "symbol", name: "HD.Ship.reset", in: "js/ship.js" },
        { task: "t2", kind: "id", name: "btn-launch", in: "index.html" },
      ],
      requires: [{ task: "t2", name: "HD.Ship" }],
      checks: [
        {
          task: "t1",
          item: "ship parses",
          kind: "command",
          cmd: "node",
          args: ["--check", "js/ship.js"],
        },
        { task: "t2", item: "page has no errors", kind: "page", path: "index.html", checks: ["no errors"] },
        { item: "test suite passes", kind: "command", cmd: "npm", args: ["test"] },
      ],
    };

    function fixture(): string {
      const dir = mkdtempSync(join(tmpdir(), "fusion-delegate-contract-"));
      mkdirSync(join(dir, "js"));
      writeFileSync(join(dir, "js", "ship.js"), "HD.Ship = class {};");
      writeFileSync(
        join(dir, "index.html"),
        '<button id="launch-btn"></button>',
      );
      return dir;
    }

    it("briefs every worker with it, checks presence on disk and runs the checks through the injected runner", async () => {
      const dir = fixture();
      try {
        const briefs: string[] = [];
        const runChecks = vi.fn(
          async (
            specs: readonly Record<string, unknown>[],
            runCtx: { workingDir: string },
          ) => ({
            ok: false,
            results: specs.map((spec) =>
              spec.kind === "page"
                ? {
                    ok: false,
                    summary:
                      "no errors: 1 pageerror — ReferenceError: p is not defined",
                  }
                : { ok: true, summary: `${runCtx.workingDir}: exit 0` },
            ),
          }),
        );
        const tool = buildFusionDelegateTool(
          deps({
            workingDir: dir,
            runChecks,
            runTurn: async (_session, userMessage) => {
              briefs.push(userMessage);
              return turnResult();
            },
          }),
        );
        const result = await tool.run(
          { tasks: TASKS, contract: CONTRACT },
          ctx({ workingDir: dir }),
        );
        expect(briefs).toHaveLength(2);
        expect(briefs[0]).toContain(
          "CONTRACT — the interface between the parts",
        );
        expect(briefs[0]).toContain(
          "You provide: symbol HD.Ship in js/ship.js; symbol HD.Ship.reset in js/ship.js",
        );
        expect(briefs[1]).toContain(
          "You may rely on: HD.Ship (symbol from t1 in js/ship.js)",
        );
        expect(briefs[0]).toContain("ship parses:");
        expect(briefs[0]).toContain("page has no errors:");
        expect(briefs[0]).toContain("test suite passes:");

        // The runner sees only verify.run specs: checklist metadata stays with the contract.
        expect(runChecks).toHaveBeenCalledTimes(1);
        expect(runChecks.mock.calls[0]![0]).toEqual([
          { kind: "command", cmd: "node", args: ["--check", "js/ship.js"] },
          { kind: "page", path: "index.html", checks: ["no errors"] },
          { kind: "command", cmd: "npm", args: ["test"] },
        ]);
        expect(runChecks.mock.calls[0]![1].workingDir).toBe(dir);

        // Presence: `HD.Ship.reset` was never written; the id is spelled the other way.
        const lines = result.summary.split("\n");
        // Error results gain a compressor signature, but the original status table stays intact.
        // t2 requires what t1 provides, so t2 ran in a second wave (F45).
        expect(lines).toContain("2 tasks in 2 waves (t1 → t2): 1 ok, 1 failed");
        expect(lines).toContain(
          "contract: 2 missing — [t1] symbol HD.Ship.reset not in js/ship.js; [t2] id btn-launch not in index.html; checklist: [t1] ship parses=PASS; [t2] page has no errors=FAIL — no errors: 1 pageerror — ReferenceError: p is not defined; test suite passes=PASS",
        );
        expect(lines).toContain(
          "- [t1] ok — One — checks: 1 of 1 passed — contract: symbol HD.Ship.reset not in js/ship.js",
        );
        // The task whose declared check failed is `failed`, with the verdict as its error.
        expect(lines).toContain(
          "- [t2] failed — Two — error: checks: no errors: 1 pageerror — ReferenceError: p is not defined — checks: 1 of 1 failed — contract: id btn-launch not in index.html",
        );
        expect(result.status).toBe("error");
        expect(result.details.checklistPassed).toBe(false);
        const rows = result.details.tasks as WorkerTaskResult[];
        expect(rows.map((r) => r.status)).toEqual(["ok", "failed"]);
        const report = result.details.contract as {
          findings: unknown[];
          checks: unknown[];
        };
        expect(report.findings).toHaveLength(3);
        expect(report.checks).toHaveLength(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not accuse cancelled tasks of missing their provides", async () => {
      // Live, run2-attempt0: a 34.5-minute fan-out ended `all_failed`
      // with every task cancelled — three of them after 0 steps — and
      // the summary still led with "9 missing — symbol Cam not in
      // scenes/js/camera.js". The files were absent because nobody had
      // started, which is the turn's story, not the workers'.
      const dir = fixture();
      const controller = new AbortController();
      controller.abort();
      try {
        const tool = buildFusionDelegateTool(
          deps({
            workingDir: dir,
            runTurn: async () => {
              const err = new Error("This operation was aborted");
              err.name = "AbortError";
              throw err;
            },
          }),
        );
        const result = await tool.run(
          { tasks: TASKS, contract: CONTRACT },
          ctx({ workingDir: dir, signal: controller.signal }),
        );
        const rows = result.details.tasks as WorkerTaskResult[];
        expect(rows.every((r) => r.status === "cancelled")).toBe(true);
        const line = result.summary
          .split("\n")
          .find((l) => l.startsWith("contract: "))!;
        expect(line).not.toContain("missing");
        expect(line).toContain(
          "3 provides not checked — the turn was cancelled",
        );
        // And no `contract:` note lands on a row that never ran.
        for (const row of rows) expect(row.notes ?? []).toEqual([]);
        const report = result.details.contract as { findings: unknown[] };
        expect(report.findings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed when declared checklist items cannot be run", async () => {
      const dir = fixture();
      try {
        const tool = buildFusionDelegateTool(deps({ workingDir: dir }));
        const result = await tool.run(
          { tasks: TASKS, contract: CONTRACT },
          ctx({ workingDir: dir }),
        );
        const contractLine = result.summary.split("\n").find((line) => line.startsWith("contract: "))!;
        expect(contractLine).toContain("[t1] ship parses=UNCHECKED");
        expect(contractLine).toContain("[t2] page has no errors=UNCHECKED");
        expect(contractLine).toContain("test suite passes=UNCHECKED");
        expect(result.status).toBe("error");
        expect(result.details.checklistPassed).toBe(false);
        const rows = result.details.tasks as WorkerTaskResult[];
        expect(rows.map((r) => r.status)).toEqual(["failed", "failed"]);
        const report = result.details.contract as { checks: Array<{ checked?: boolean; ok: boolean }> };
        expect(report.checks).toHaveLength(3);
        expect(report.checks.every((check) => check.checked === false && check.ok === false)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails the whole fan-out on a failing call-level behavior item even when all workers are ok", async () => {
      const tool = buildFusionDelegateTool(
        deps({
          runChecks: async (specs) => ({
            ok: false,
            results: specs.map(() => ({ ok: false, summary: "probe wall moved: expected true, got false" })),
          }),
        }),
      );
      const result = await tool.run(
        {
          tasks: TASKS,
          contract: {
            checks: [
              { item: "wall breaks after impact", kind: "command", cmd: "node", args: ["behavior.js"] },
            ],
          },
        },
        ctx(),
      );
      expect((result.details.tasks as WorkerTaskResult[]).every((row) => row.status === "ok")).toBe(true);
      expect(result.status).toBe("error");
      expect(result.details.checklistPassed).toBe(false);
      expect(result.summary).toContain("wall breaks after impact=FAIL");
      expect(result.summary).toContain("expected true, got false");
    });

    it("pins the full behavior checklist across repairs and until the operator turn ends", async () => {
      let behaviorPasses = false;
      let workerTurns = 0;
      let turnId = "turn-a";
      const runChecks = vi.fn(async (specs: readonly Record<string, unknown>[]) => ({
        ok: behaviorPasses,
        results: specs.map(() => ({
          ok: behaviorPasses,
          summary: behaviorPasses ? "passed" : "behavior mismatch",
        })),
      }));
      const tool = buildFusionDelegateTool(
        deps({
          resolveOperatorTurnId: () => turnId,
          runChecks,
          runTurn: async () => {
            workerTurns += 1;
            return turnResult();
          },
        }),
      );
      const checklist = [
        { item: "wall breaks after impact", kind: "command", cmd: "node", args: ["wall.js"] },
        { item: "boxes move from spawn", kind: "command", cmd: "node", args: ["boxes.js"] },
      ];
      const callCtx = ctx();

      const first = await tool.run(
        { tasks: TASKS, contract: { checks: checklist } },
        callCtx,
      );
      expect(first.status).toBe("error");
      expect(first.details.checklistPassed).toBe(false);
      const turnsAfterFailure = workerTurns;

      const narrowed = await tool.run(
        { tasks: TASKS, contract: { checks: [checklist[0]] } },
        callCtx,
      );
      expect(narrowed.status).toBe("error");
      expect(narrowed.details.reason).toBe("behavior-checklist-changed");
      expect(narrowed.details.requiredChecklistItems).toEqual([
        "wall breaks after impact",
        "boxes move from spawn",
      ]);
      expect(workerTurns).toBe(turnsAfterFailure);

      behaviorPasses = true;
      const repaired = await tool.run(
        { tasks: TASKS, contract: { checks: checklist } },
        callCtx,
      );
      expect(repaired.status).toBe("ok");
      expect(repaired.details.checklistPassed).toBe(true);

      // PASS verifies current bytes, but the acceptance contract remains pinned for this turn.
      const turnsAfterPass = workerTurns;
      const narrowedAfterPass = await tool.run(
        { tasks: TASKS, contract: { checks: [checklist[0]] } },
        callCtx,
      );
      expect(narrowedAfterPass.status).toBe("error");
      expect(narrowedAfterPass.details.reason).toBe("behavior-checklist-changed");
      expect(workerTurns).toBe(turnsAfterPass);

      const omittedAfterPass = await tool.run({ tasks: TASKS }, callCtx);
      expect(omittedAfterPass.status).toBe("error");
      expect(omittedAfterPass.details.reason).toBe("behavior-checklist-changed");
      expect(workerTurns).toBe(turnsAfterPass);

      const sameFullChecklist = await tool.run(
        { tasks: TASKS, contract: { checks: checklist } },
        callCtx,
      );
      expect(sameFullChecklist.status).toBe("ok");
      expect(workerTurns).toBeGreaterThan(turnsAfterPass);

      // Only a new operator turn releases the old acceptance contract.
      turnId = "turn-b";
      const turnsBeforeNewTurn = workerTurns;
      const next = await tool.run(
        { tasks: TASKS, contract: { checks: [checklist[0]] } },
        callCtx,
      );
      expect(next.details.reason).not.toBe("behavior-checklist-changed");
      expect(workerTurns).toBeGreaterThan(turnsBeforeNewTurn);
      expect(runChecks).toHaveBeenCalledTimes(4);
    });

    it("does not invent a checklist PASS for an optional unchecked fan-out", async () => {
      const tool = buildFusionDelegateTool(deps());
      for (const contract of [undefined, { owners: { "out.txt": "t1" } }]) {
        const result = await tool.run({ tasks: TASKS, ...(contract ? { contract } : {}) }, ctx());
        expect(result.status).toBe("ok");
        expect(result.details.checklistPassed).toBeUndefined();
        expect(result.summary).not.toContain("checklist:");
      }
    });

    it("reads checklist opt-in live, without making it a global refusal", async () => {
      let required = false;
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({
        runTurn, requireBehaviorChecklist: () => required,
      }));
      expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
      const before = runTurn.mock.calls.length;
      required = true;
      expect((await tool.run({ tasks: TASKS }, ctx())).details.reason).toBe("behavior-checklist-required");
      expect(runTurn).toHaveBeenCalledTimes(before);
      required = false;
      expect((await tool.run({ tasks: TASKS }, ctx())).status).toBe("ok");
      expect(runTurn.mock.calls.length).toBeGreaterThan(before);
    });

    it("keeps malformed explicitly declared checks unaccepted with opt-in off", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({ runTurn, requireBehaviorChecklist: false }));
      const result = await tool.run({ tasks: TASKS, contract: {
        checks: [{ item: "boundary", task: "unknown-task", kind: "command", cmd: "node" }],
      } }, ctx());
      expect(result.status).toBe("error");
      expect(result.details.checklistPassed).toBe(false);
      expect(result.summary).toContain("boundary=UNCHECKED");
      expect(runTurn).not.toHaveBeenCalled();
    });

    it.each([false, true])("cannot drop named checks while repairing invalid arguments (required=%s)", async (required) => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({
        runTurn, requireBehaviorChecklist: required,
        runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) }),
      }));
      const callCtx = ctx();
      const wall = { item: "wall", kind: "command", cmd: "node", args: ["wall.js"] };
      const boxes = { item: "boxes", kind: "command", cmd: "node", args: ["boxes.js"] };
      const invalid = await tool.run({ tasks: TASKS, contract: { checks: [{ ...wall, task: "unknown-task" }, boxes] } }, callCtx);
      expect(invalid.status).toBe("error");
      expect(invalid.details.checklistPassed).toBe(false);
      const narrowed = await tool.run({ tasks: TASKS, contract: { checks: [wall] } }, callCtx);
      expect(narrowed.status).toBe("error");
      expect(narrowed.details.reason).toBe("behavior-checklist-changed");
      expect(runTurn).not.toHaveBeenCalled();
      const repaired = await tool.run({ tasks: TASKS, contract: { checks: [wall, boxes] } }, callCtx);
      expect(repaired.status).toBe("ok");
      expect(repaired.details.checklistPassed).toBe(true);
      expect(runTurn).toHaveBeenCalled();
      const afterPass = await tool.run({ tasks: TASKS, contract: { checks: [wall] } }, callCtx);
      expect(afterPass.details.reason).toBe("behavior-checklist-changed");
    });

    it("keeps an unnamed declared item repairable but does not let it disappear", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({ runTurn, requireBehaviorChecklist: true,
        runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) }),
      }));
      const callCtx = ctx();
      const wall = { item: "wall", kind: "command", cmd: "node" };
      const unnamed = { kind: "command", cmd: "node" };
      expect((await tool.run({ tasks: TASKS, contract: { checks: [wall, unnamed] } }, callCtx)).status).toBe("error");
      const narrowed = await tool.run({ tasks: TASKS, contract: { checks: [wall] } }, callCtx);
      expect(narrowed.details.reason).toBe("behavior-checklist-changed");
      expect(runTurn).not.toHaveBeenCalled();
      const repaired = await tool.run({ tasks: TASKS, contract: { checks: [wall, { ...unnamed, item: "boxes" }] } }, callCtx);
      expect(repaired.status).toBe("ok");
      expect(repaired.details.checklistPassed).toBe(true);
    });

    it.each([false, true])("pins named items in invalid JSON-string contracts (required=%s)", async (required) => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({
        runTurn, requireBehaviorChecklist: required,
        runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) }),
      }));
      const callCtx = ctx();
      const wall = { item: "wall", kind: "command", cmd: "node" };
      const invalid = await tool.run({ tasks: TASKS, contract: JSON.stringify({ checks: [{ ...wall, task: "unknown-task" }] }) }, callCtx);
      expect(invalid.details.checklistPassed).toBe(false);
      expect(invalid.summary).toContain("wall=UNCHECKED");
      const omitted = await tool.run({ tasks: TASKS }, callCtx);
      expect(omitted.details.reason).toBe("behavior-checklist-changed");
      expect(runTurn).not.toHaveBeenCalled();
      const repaired = await tool.run({ tasks: TASKS, contract: JSON.stringify({ checks: [wall] }) }, callCtx);
      expect(repaired.status).toBe("ok");
    });

    it("cannot substitute known names while naming a JSON-string checklist", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({
        runTurn, requireBehaviorChecklist: true,
        runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) }),
      }));
      const callCtx = ctx();
      const spec = { kind: "command", cmd: "node" };
      const invoke = (items: Record<string, unknown>[]) => tool.run({ tasks: TASKS, contract: JSON.stringify({ checks: items }) }, callCtx);
      expect((await invoke([{ ...spec, item: "wall" }, spec])).status).toBe("error");
      expect((await invoke([{ ...spec, item: "renamed" }, { ...spec, item: "boxes" }])).details.reason).toBe("behavior-checklist-changed");
      expect(runTurn).not.toHaveBeenCalled();
      expect((await invoke([{ ...spec, item: "wall" }, { ...spec, item: "boxes" }])).status).toBe("ok");
    });

    it("treats null checks as absent even when an unrelated task argument is invalid", async () => {
      const tool = buildFusionDelegateTool(deps({ requireBehaviorChecklist: true }));
      const result = await tool.run({ tasks: [], contract: { checks: null } }, ctx());
      expect(result.status).toBe("error");
      expect(result.details.checklistPassed).toBeUndefined();
    });

    it("enforces a newly enabled naming policy without releasing an existing pin", async () => {
      let required = false;
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({
        runTurn, requireBehaviorChecklist: () => required,
        runChecks: async (specs) => ({ ok: true, results: specs.map(() => ({ ok: true, summary: "passed" })) }),
      }));
      const callCtx = ctx();
      const checks = [{ kind: "command", cmd: "node" }];
      const args = { tasks: TASKS, contract: { checks } };
      expect((await tool.run(args, callCtx)).status).toBe("ok");
      const callsBefore = runTurn.mock.calls.length;
      required = true;
      const refused = await tool.run(args, callCtx);
      expect(refused.status).toBe("error");
      expect(refused.details.reason).toBe("behavior-checklist-items-must-be-named");
      expect(refused.details.checklistPassed).toBe(false);
      expect(runTurn).toHaveBeenCalledTimes(callsBefore);
      const changed = await tool.run({ tasks: TASKS, contract: { checks: [{ ...checks[0], item: "renamed" }] } }, callCtx);
      expect(changed.details.reason).toBe("behavior-checklist-changed");
      required = false;
      expect((await tool.run(args, callCtx)).status).toBe("ok");
      expect(runTurn.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("requires a named behavior checklist only when explicitly enabled", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(
        deps({
          requireBehaviorChecklist: true,
          runTurn,
          runChecks: async (specs) => ({
            ok: true,
            results: specs.map(() => ({ ok: true, summary: "passed" })),
          }),
        }),
      );
      // Independent invalid requests: no checklist carries across these examples.

      const missing = await tool.run({ tasks: TASKS }, ctx());
      expect(missing.status).toBe("error");
      expect(missing.details.reason).toBe("behavior-checklist-required");
      expect(missing.details.checklistPassed).toBe(false);
      expect(missing.summary).toContain("behavior acceptance=UNCHECKED");
      expect(runTurn).not.toHaveBeenCalled();

      const unnamed = await tool.run(
        {
          tasks: TASKS,
          contract: {
            checks: [{ kind: "command", cmd: "node", args: ["check.js"] }],
          },
        },
        ctx(),
      );
      expect(unnamed.status).toBe("error");
      expect(unnamed.details.reason).toBe("behavior-checklist-items-must-be-named");
      expect(unnamed.details.checklistPassed).toBe(false);
      expect(unnamed.summary).toContain("check-1=UNCHECKED");
      expect(runTurn).not.toHaveBeenCalled();

      const malformed = await tool.run(
        {
          tasks: TASKS,
          contract: {
            checks: [{ item: "", kind: "command", cmd: "node", args: ["check.js"] }],
          },
        },
        ctx(),
      );
      expect(malformed.status).toBe("error");
      expect(malformed.details.reason).toBe("behavior-checklist-invalid");
      expect(malformed.details.checklistPassed).toBe(false);
      expect(malformed.summary).toContain("check-1=UNCHECKED");
      expect(runTurn).not.toHaveBeenCalled();

      const namedMalformed = await tool.run(
        {
          tasks: TASKS,
          contract: {
            checks: [
              { task: "missing-worker", item: "wall breaks after impact", kind: "command", cmd: "node", args: ["wall.js"] },
              { item: "boxes render away from origin", kind: "command", cmd: "node", args: ["boxes.js"] },
            ],
          },
        },
        ctx(),
      );
      expect(namedMalformed.status).toBe("error");
      expect(namedMalformed.details.reason).toBe("behavior-checklist-invalid");
      expect(namedMalformed.details.checklistPassed).toBe(false);
      expect(namedMalformed.details.requiredChecklistItems).toEqual([
        "wall breaks after impact",
        "boxes render away from origin",
      ]);
      expect(namedMalformed.summary).toContain("wall breaks after impact=UNCHECKED");
      expect(namedMalformed.summary).toContain("boxes render away from origin=UNCHECKED");
      expect(runTurn).not.toHaveBeenCalled();

      const checked = await tool.run(
        {
          tasks: TASKS,
          contract: {
            checks: [
              { item: "requested behavior is verified", kind: "command", cmd: "node", args: ["check.js"] },
            ],
          },
        },
        ctx(), // a new request may choose a different checklist
      );
      expect(checked.details.reason).not.toBe("behavior-checklist-required");
      expect(runTurn).toHaveBeenCalled();
    });

    it("stops after three failed full-checklist repair rounds and reports the remaining items", async () => {
      let turnId = "turn-a";
      let workerTurns = 0;
      const runChecks = vi.fn(async (specs: readonly Record<string, unknown>[]) => ({
        ok: false,
        results: specs.map(() => ({ ok: false, summary: "still wrong" })),
      }));
      const tool = buildFusionDelegateTool(
        deps({
          resolveOriginalRequest: () => "identical request",
          resolveOperatorTurnId: () => turnId,
          runChecks,
          runTurn: async () => {
            workerTurns += 1;
            return turnResult();
          },
        }),
      );
      const checklist = [
        { item: "wall breaks after impact", kind: "command", cmd: "node", args: ["wall.js"] },
        { item: "boxes render away from origin", kind: "command", cmd: "node", args: ["boxes.js"] },
      ];
      const args = { tasks: TASKS, contract: { checks: checklist } };
      const callCtx = ctx();

      for (let round = 1; round <= 3; round += 1) {
        const result = await tool.run(args, callCtx);
        expect(result.status).toBe("error");
        expect(result.details.checklistPassed).toBe(false);
        expect(result.details.behaviorRepair).toEqual({
          round,
          maxRounds: 3,
          remaining: 3 - round,
        });
      }
      const turnsAfterBudget = workerTurns;
      expect(runChecks).toHaveBeenCalledTimes(3);

      const exhausted = await tool.run(args, callCtx);
      expect(exhausted.status).toBe("error");
      expect(exhausted.details.reason).toBe("behavior-repair-budget-exhausted");
      expect(exhausted.details.failedRounds).toBe(3);
      expect(exhausted.details.maxRounds).toBe(3);
      expect(exhausted.details.requiredChecklistItems).toEqual([
        "wall breaks after impact",
        "boxes render away from origin",
      ]);
      expect(workerTurns).toBe(turnsAfterBudget);
      expect(runChecks).toHaveBeenCalledTimes(3);

      // A new operator request starts a fresh repair cycle.
      turnId = "turn-b";
      const fresh = await tool.run(args, callCtx);
      expect(fresh.details.reason).not.toBe("behavior-repair-budget-exhausted");
      expect(fresh.details.behaviorRepair).toEqual({ round: 1, maxRounds: 3, remaining: 2 });
      expect(workerTurns).toBeGreaterThan(turnsAfterBudget);
      expect(runChecks).toHaveBeenCalledTimes(4);
    });

    it("counts failed full-checklist rounds cumulatively across intervening passes", async () => {
      let workerTurns = 0;
      const verdicts = [false, false, true, false];
      const runChecks = vi.fn(async (specs: readonly Record<string, unknown>[]) => {
        const ok = verdicts.shift() ?? false;
        return { ok, results: specs.map(() => ({ ok, summary: ok ? "passed" : "still wrong" })) };
      });
      const tool = buildFusionDelegateTool(
        deps({
          resolveOperatorTurnId: () => "turn-cumulative-budget",
          runChecks,
          runTurn: async () => {
            workerTurns += 1;
            return turnResult();
          },
        }),
      );
      const checklist = [
        { item: "wall breaks after impact", kind: "command", cmd: "node", args: ["wall.js"] },
        { item: "boxes render away from origin", kind: "command", cmd: "node", args: ["boxes.js"] },
      ];
      const args = { tasks: TASKS, contract: { checks: checklist } };
      const callCtx = ctx();

      const first = await tool.run(args, callCtx);
      expect(first.details.behaviorRepair).toEqual({ round: 1, maxRounds: 3, remaining: 2 });
      const second = await tool.run(args, callCtx);
      expect(second.details.behaviorRepair).toEqual({ round: 2, maxRounds: 3, remaining: 1 });
      const passing = await tool.run(args, callCtx);
      expect(passing.status).toBe("ok");
      expect(passing.details.checklistPassed).toBe(true);
      const thirdFailure = await tool.run(args, callCtx);
      expect(thirdFailure.details.behaviorRepair).toEqual({ round: 3, maxRounds: 3, remaining: 0 });

      const turnsBeforeBlock = workerTurns;
      const exhausted = await tool.run(args, callCtx);
      expect(exhausted.status).toBe("error");
      expect(exhausted.details.reason).toBe("behavior-repair-budget-exhausted");
      expect(exhausted.details.failedRounds).toBe(3);
      expect(workerTurns).toBe(turnsBeforeBlock);
      expect(runChecks).toHaveBeenCalledTimes(4);
    });

    it("briefs named checks before work and runs deterministic verification before returning", async () => {
      const order: string[] = [];
      const check = { item: "build is healthy", kind: "command", cmd: process.execPath, args: ["-e", "process.exit(0)"] };
      const tool = buildFusionDelegateTool(deps({
        runTurn: async (_session, brief) => {
          expect(brief).toContain("build is healthy");
          expect(order).toEqual([]);
          order.push("worker");
          return turnResult();
        },
        runChecks: async (specs, context) => {
          expect(specs).toEqual([{ kind: check.kind, cmd: check.cmd, args: check.args }]);
          expect(order).toEqual(["worker"]);
          order.push("deterministic");
          return runVerifyChecks(specs, context);
        },
      }));
      const dir = mkdtempSync(join(tmpdir(), "fusion-check-order-"));
      try {
        const result = await tool.run({ tasks: [TASKS[0]], contract: { checks: [check] } }, ctx({ workingDir: dir }));
        expect(result.details.checklistPassed).toBe(true);
        expect(order).toEqual(["worker", "deterministic"]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("returns only failing or unchecked items after three full rounds", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({ runTurn,
        runChecks: async () => ({ ok: false, results: [{ ok: true }, { ok: false }] }),
      }));
      const checks = ["build", "wall", "boxes"].map((item) => ({ item, kind: "command", cmd: "node" }));
      const args = { tasks: [TASKS[0]], contract: { checks } };
      const callCtx = ctx();
      for (let i = 0; i < 3; i += 1) await tool.run(args, callCtx);
      const blocked = await tool.run(args, callCtx);
      expect(blocked.details.remainingChecklistItems).toEqual(["wall", "boxes"]);
      expect(blocked.details.requiredChecklistItems).toEqual(["build", "wall", "boxes"]);
      expect(blocked.summary).toContain("remaining failing/unchecked items: wall; boxes");
      expect(runTurn).toHaveBeenCalledTimes(3);
    });

    it("keeps a declared checklist pinned after fan-out denial without spending a full round", async () => {
      const tool = buildFusionDelegateTool(deps({ approvalRequired: true,
        approvals: { request: async () => { throw new Error("denied"); }, setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
      }));
      const callCtx = ctx();
      const denied = await tool.run({ tasks: TASKS, contract: { checks: [{ item: "build", kind: "command", cmd: "node" }] } }, callCtx);
      expect(denied.details.checklistPassed).toBe(false);
      expect(denied.summary).toContain("build=UNCHECKED");
      expect(denied.details.behaviorRepair).toBeUndefined();
      const reduced = await tool.run({ tasks: TASKS }, callCtx);
      expect(reduced.details.reason).toBe("behavior-checklist-changed");
    });

    it("does not spend checklist rounds on worker failures when every check passes", async () => {
      const runTurn = vi.fn(async () => { throw new Error("worker unavailable"); });
      const tool = buildFusionDelegateTool(deps({ runTurn,
        runChecks: async () => ({ ok: true, results: [{ ok: true }] }),
      }));
      const callCtx = ctx();
      for (let i = 0; i < 4; i += 1) {
        const result = await tool.run({ tasks: [TASKS[0]], contract: { checks: [{ item: "build", kind: "command", cmd: "node" }] } }, callCtx);
        expect(result.details.checklistPassed).toBe(true);
        expect(result.details.behaviorRepair).toBeUndefined();
        expect(result.details.reason).not.toBe("behavior-repair-budget-exhausted");
        expect(result.status).toBe("error");
      }
      expect(runTurn).toHaveBeenCalledTimes(4);
    });

    it("resets the fallback cycle on a new turn signal without a resolver", async () => {
      const tool = buildFusionDelegateTool(deps({ runChecks: async () => ({ ok: false, results: [{ ok: false }] }) }));
      const args = { tasks: [TASKS[0]], contract: { checks: [{ item: "build", kind: "command", cmd: "node" }] } };
      const firstTurn = ctx();
      for (let i = 0; i < 3; i += 1) await tool.run(args, firstTurn);
      expect((await tool.run(args, firstTurn)).details.reason).toBe("behavior-repair-budget-exhausted");
      expect((await tool.run(args, ctx())).details.behaviorRepair).toMatchObject({ round: 1 });
    });

    it("preserves maximum checklist verdicts through a tiny output budget", async () => {
      const checks = Array.from({ length: 16 }, (_, i) => ({ item: String(i).padEnd(120, "x"), kind: "command", cmd: "node" }));
      const tool = buildFusionDelegateTool(deps({ outputCharCap: 100,
        runChecks: async () => ({ ok: false, results: checks.map((_, i) => ({ ok: i < 15 })) }),
      }));
      const upstreamId = "a".repeat(1000);
      const result = await tool.run({
        tasks: [{ id: upstreamId, instructions: "provide ready" }, { id: "downstream", instructions: "consume ready" }],
        contract: { checks, provides: [{ task: upstreamId, kind: "other", name: "ready", in: "ready.txt" }], requires: [{ task: "downstream", name: "ready" }] },
      }, ctx());
      checks.forEach((check, i) => expect(result.summary).toContain(check.item + "=" + (i === 15 ? "FAIL" : "PASS")));
    });

    it("catches the published #539 benchmark-derived origin-box and broken-wall regressions automatically", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fusion-behavior-physics-"));
      const drawPath = join(dir, "draw.js");
      const wallPath = join(dir, "wall.js");
      writeFileSync(
        join(dir, "physics.js"),
        "globalThis.PHYS={corners:(b)=>[{w:{x:b.pos.x+1,y:0,z:0},o:{x:1,y:0,z:0}}]};",
      );
      // Published evidence anchors:
      // - #491 gist 918ff030…: producer world point `w`, local offset `o`, consumer used the opposite meaning.
      // - #539 trace a9dc76c2… + 03-wrecking spec: 6x4=24 bricks, impact around t=2..3.
      // - #539 acceptance example: after second 3, >=6 bricks moved more than 0.5 units.
      writeFileSync(
        drawPath,
        "globalThis.projectedBoxX=(b)=>globalThis.PHYS.corners(b)[0].o.x;",
      );
      writeFileSync(
        wallPath,
        [
          "exports.makeWall=()=>Array.from({length:24},(_,i)=>({id:i,startX:1.3,pos:{x:1.3},vel:{x:0},fixed:true}));",
          "exports.after3=()=>{const b=exports.makeWall();const dt=1/120;for(let t=0;t<3;t+=dt){for(const x of b){if(!x.fixed)x.pos.x+=x.vel.x*dt;}}return b;};",
        ].join(""),
      );
      const originScript = [
        "require(\"./physics.js\");require(\"./draw.js\");",
        "const got=globalThis.projectedBoxX({pos:{x:10}});",
        "if(got!==11){console.error(\"box projected at local/origin x=\"+got);process.exit(1);}",
      ].join("");
      const wallScript = [
        "const wall=require(\"./wall.js\");",
        "const after=wall.after3();",
        "const moved=after.filter((b)=>Math.abs(b.pos.x-b.startX)>0.5).length;",
        "if(moved<6){console.error(\"wall moved bricks=\"+moved);process.exit(1);}",
      ].join("");
      const checklist = [
        {
          item: "boxes render at body position, not origin",
          kind: "command",
          cmd: process.execPath,
          args: ["-e", originScript],
          checks: ["exit 0"],
        },
        {
          item: "after second 3 at least 6 wall bricks moved >0.5",
          kind: "command",
          cmd: process.execPath,
          args: ["-e", wallScript],
          checks: ["exit 0"],
        },
      ];
      const tool = buildFusionDelegateTool(deps({ runChecks: runVerifyChecks }));
      const callCtx = ctx({ workingDir: dir });
      const args = {
        tasks: [{ id: "physics", instructions: "implement the five-scene physics behavior" }],
        contract: { checks: checklist },
      };
      try {
        const broken = await tool.run(args, callCtx);
        expect(broken.status).toBe("error");
        expect(broken.details.checklistPassed).toBe(false);
        expect(broken.summary).toContain("boxes render at body position, not origin=FAIL");
        expect(broken.summary).toContain("after second 3 at least 6 wall bricks moved >0.5=FAIL");

        // Repair both behaviors, then rerun the SAME pinned checklist.
        writeFileSync(
          drawPath,
          "globalThis.projectedBoxX=(b)=>globalThis.PHYS.corners(b)[0].w.x;",
        );
        writeFileSync(
          wallPath,
          [
            "exports.makeWall=()=>Array.from({length:24},(_,i)=>({id:i,startX:1.3,pos:{x:1.3},vel:{x:0},fixed:true,releaseAt:2+i*0.01}));",
            "exports.after3=()=>{const b=exports.makeWall();const dt=1/120;for(let t=0;t<3;t+=dt){for(const x of b){if(x.id<8&&x.fixed&&t>=x.releaseAt){x.fixed=false;x.vel.x=1;}if(!x.fixed)x.pos.x+=x.vel.x*dt;}}return b;};",
          ].join(""),
        );
        const fixed = await tool.run(args, callCtx);
        expect(fixed.status).toBe("ok");
        expect(fixed.details.checklistPassed).toBe(true);
        expect(fixed.summary).toContain("boxes render at body position, not origin=PASS");
        expect(fixed.summary).toContain("after second 3 at least 6 wall bricks moved >0.5=PASS");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("checks all five published #539 scene acceptance points and both documented regressions", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fusion-five-scene-benchmark-"));
      const benchmarkPath = join(dir, "benchmark.js");
      const writeBenchmark = (originBug: boolean, wallBug: boolean) => {
        writeFileSync(
          benchmarkPath,
          [
            "const DT=1/120,G=-18;const stepTo=(seconds,state,step)=>{for(let t=0;t<seconds;t+=DT)step(state,t,DT);return state;};",
            "exports.tower=(seconds)=>{const cubes=Array.from({length:6},(_,i)=>({i,y:.5+i,vy:0,x:0,vx:0,kicked:false}));stepTo(seconds,cubes,(s,t,dt)=>{if(t<1)return;for(const c of s){if(!c.kicked){c.kicked=true;c.vx=(c.i+1)*.28;}c.vy+=G*dt;c.y+=c.vy*dt;c.x+=c.vx*dt;if(c.y<=.5){c.y=.5;c.vy=Math.abs(c.vy)*.26;c.vx*=.85;if(Math.abs(c.vy)<.03)c.vy=0;if(Math.abs(c.vx)<.03)c.vx=0;}if(t>=6.5){c.y=.5;c.vy=c.vx=0;}}});return{still:cubes.every((c,i)=>Math.abs(c.y-(.5+i))<1e-9&&Math.abs(c.x)<1e-9),fallen:cubes.filter((c,i)=>i>0&&c.y<1).length,settled:cubes.filter(c=>c.y<=.501&&Math.abs(c.vy)<.05&&Math.abs(c.vx)<.05).length};};",
            "exports.ballBox=(seconds)=>{const rs=[.25,.32,.38,.44,.5];const balls=rs.map((r,i)=>({r,x:-1.5+i*.75,y:r,z:0,vx:0,vy:0,vz:0,fired:false}));stepTo(seconds,balls,(s,t,dt)=>{for(const b of s){if(t>=1&&!b.fired){b.fired=true;b.vx=2.5-b.r;b.vy=6+b.r;b.vz=1-b.r;}if(!b.fired)continue;b.vy+=G*dt;b.x+=b.vx*dt;b.y+=b.vy*dt;b.z+=b.vz*dt;const rest=Math.max(.18,.95-Math.max(0,t-1)*.14);if(b.y<b.r){b.y=b.r;b.vy=Math.abs(b.vy)*rest;}if(b.x>2-b.r||b.x<-2+b.r){b.x=Math.max(-2+b.r,Math.min(2-b.r,b.x));b.vx*=-rest;}if(b.z>1.5-b.r||b.z<-1.5+b.r){b.z=Math.max(-1.5+b.r,Math.min(1.5-b.r,b.z));b.vz*=-rest;}b.vx*=.998;b.vz*=.998;if(t>=6.5){b.y=b.r;b.vx=b.vy=b.vz=0;}}});return{moving:balls.filter(b=>Math.hypot(b.vx,b.vy,b.vz)>.1).length,resting:balls.filter(b=>Math.hypot(b.vx,b.vy,b.vz)<.01&&Math.abs(b.y-b.r)<.001).length};};",
            "exports.makeWall=()=>Array.from({length:24},(_,i)=>({id:i,startX:1.3,pos:{x:1.3,y:.19+(i%6)*.38,z:(Math.floor(i/6)-1.5)*.55},vel:{x:0,y:0},fixed:true}));",
            wallBug
              ? "exports.wallAfter3=()=>exports.makeWall();"
              : "exports.wallAfter3=()=>{const b=exports.makeWall();let th=-1,w=0,hit=false;stepTo(3,b,(bricks,t,dt)=>{if(t>=1&&!hit){w+=(G/5)*Math.sin(th)*dt;th+=w*dt;const bx=-.2+5*Math.sin(th);if(bx>=.45){hit=true;for(let i=0;i<8;i++){bricks[i].fixed=false;bricks[i].vel.x=1.2+.08*i;bricks[i].vel.y=.8+.05*i;}}}for(const x of bricks){if(x.fixed)continue;x.vel.y+=G*dt;x.pos.x+=x.vel.x*dt;x.pos.y+=x.vel.y*dt;if(x.pos.y<.19){x.pos.y=.19;x.vel.y=Math.abs(x.vel.y)*.2;x.vel.x*=.97;}}});return b;};",
            "exports.seesaw=(seconds)=>{const s={angle:.275,av:0,ballY:4,ballVy:0,hit:false,cubeY:.3,cubeVy:0,cubePeakY:.3,minAngle:.275};stepTo(seconds,s,(x,t,dt)=>{if(t<1)return;if(!x.hit){x.ballVy+=G*dt;x.ballY+=x.ballVy*dt;if(x.ballY<=1.35){x.hit=true;x.av=-2.2;x.cubeVy=8.5;}}if(x.hit){x.angle+=x.av*dt;x.av*=.992;x.minAngle=Math.min(x.minAngle,x.angle);x.cubeVy+=G*dt;x.cubeY+=x.cubeVy*dt;if(x.cubeY<.3){x.cubeY=.3;x.cubeVy=0;}x.cubePeakY=Math.max(x.cubePeakY,x.cubeY);}});return s;};",
            "exports.bounce=(seconds)=>{const rest=[.9,.65,.35,.08];const balls=rest.map((r)=>({r,y:3,vy:0,dropped:false,impacts:0,peak:.5,tracking:false}));stepTo(seconds,balls,(s,t,dt)=>{for(const b of s){if(t<1)continue;b.dropped=true;b.vy+=G*dt;b.y+=b.vy*dt;if(b.y<.5){b.y=.5;b.vy=Math.abs(b.vy)*b.r;b.impacts++;b.tracking=true;}if(b.tracking)b.peak=Math.max(b.peak,b.y);if(t>=6.5){b.y=.5;b.vy=0;}}});return{peaks:balls.map(b=>b.peak),resting:balls.filter(b=>Math.abs(b.vy)<.01&&Math.abs(b.y-.5)<.001).length};};",
            "exports.corners=(b)=>[{w:{x:b.pos.x+1},o:{x:1}}];",
            originBug
              ? "exports.projectedBoxX=(b)=>exports.corners(b)[0].o.x;"
              : "exports.projectedBoxX=(b)=>exports.corners(b)[0].w.x;",
          ].join(""),
        );
      };
      const command = (item: string, body: string) => ({
        item,
        kind: "command",
        cmd: process.execPath,
        args: ["-e", `const b=require("./benchmark.js");${body}`],
        checks: ["exit 0"],
      });
      const checks = [
        command(
          "scene 1 TOWER: still before 1s, collapsed by 3s, settled by 7s",
          "if(!b.tower(.5).still||b.tower(3).fallen<4||b.tower(7).settled!==6)process.exit(1);",
        ),
        command(
          "scene 2 BALL BOX: all five move after impulse and rest by 7s",
          "if(b.ballBox(2).moving!==5||b.ballBox(7).resting!==5)process.exit(1);",
        ),
        command(
          "scene 3 WRECKING BALL: after 3s at least 6 bricks moved >0.5",
          "const a=b.wallAfter3();const n=a.filter(x=>Math.abs(x.pos.x-x.startX)>.5).length;if(n<6)process.exit(1);",
        ),
        command(
          "scene 4 SEESAW: plank pivots and light cube is launched",
          "const s=b.seesaw(3);if(!(s.minAngle<0&&s.cubePeakY>1))process.exit(1);",
        ),
        command(
          "scene 5 BOUNCE TEST: material bounce heights differ and all rest by 7s",
          "const h=b.bounce(4).peaks;if(!(h[0]>h[1]&&h[1]>h[2]&&h[2]>h[3])||b.bounce(7).resting!==4)process.exit(1);",
        ),
        command(
          "shared box rendering uses world position, not local origin offset",
          "if(b.projectedBoxX({pos:{x:10}})!==11)process.exit(1);",
        ),
      ];
      const expectedSpecs = checks.map(({ item: _item, ...spec }) => spec);
      const checked = vi.fn(async (specs: readonly Record<string, unknown>[], runCtx: { workingDir: string; signal: AbortSignal }) => {
        expect(specs).toEqual(expectedSpecs);
        return runVerifyChecks(specs, runCtx);
      });
      const tool = buildFusionDelegateTool(deps({ runChecks: checked }));
      const callCtx = ctx({ workingDir: dir });
      const args = {
        tasks: [{ id: "physics", instructions: "implement the five published physics scenes" }],
        contract: { checks },
      };
      try {
        // Round 1: the published broken-wall class is present; origin rendering still passes.
        writeBenchmark(false, true);
        const wallBroken = await tool.run(args, callCtx);
        expect(wallBroken.status).toBe("error");
        expect(wallBroken.summary).toContain("scene 3 WRECKING BALL: after 3s at least 6 bricks moved >0.5=FAIL");
        for (const check of checks.filter((check) => !check.item.startsWith("scene 3 "))) {
          expect(wallBroken.summary).toContain(`${check.item}=PASS`);
        }

        // Round 2: wall fix lands, but a regression recreates the published origin-box class.
        // The full pinned checklist must rerun, so the previously-passing render item now fails.
        writeBenchmark(true, false);
        const originRegressed = await tool.run(args, callCtx);
        expect(originRegressed.status).toBe("error");
        for (const check of checks.filter((check) => !check.item.startsWith("shared box rendering"))) {
          expect(originRegressed.summary).toContain(`${check.item}=PASS`);
        }
        expect(originRegressed.summary).toContain("shared box rendering uses world position, not local origin offset=FAIL");

        // Round 3: both documented defects are repaired; every scene/check is re-run and passes.
        writeBenchmark(false, false);
        const fixed = await tool.run(args, callCtx);
        expect(fixed.status).toBe("ok");
        expect(fixed.details.checklistPassed).toBe(true);
        for (const check of checks) expect(fixed.summary).toContain(`${check.item}=PASS`);
        expect(checked).toHaveBeenCalledTimes(3);
        for (const [specs] of checked.mock.calls) expect(specs).toEqual(expectedSpecs);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("runs a contract whose require has no provider and whose provide cannot be checked, warning everyone instead of refusing", async () => {
      // Live, 2026-09-15: the third and fourth consecutive refusals of
      // one fan-out, ~4–5 minutes of local generation each, were these
      // two. Neither stops a worker from working, so the call runs and
      // the notes travel with it — into every brief, onto the
      // `contract:` line, into the details.
      const dir = fixture();
      try {
        const briefs: string[] = [];
        const tool = buildFusionDelegateTool(
          deps({
            workingDir: dir,
            runTurn: async (_session, userMessage) => {
              briefs.push(userMessage);
              return turnResult();
            },
          }),
        );
        const result = await tool.run(
          {
            tasks: [
              { id: "t1", title: "One", instructions: "x" },
              { id: "organize", instructions: "y" },
            ],
            contract: {
              provides: [
                {
                  task: "t1",
                  kind: "symbol",
                  name: "HD.Ship",
                  in: "js/ship.js",
                },
                { task: "organize", kind: "other", name: "done" },
              ],
              requires: [{ task: "t1", name: "organized_files" }],
            },
          },
          ctx({ workingDir: dir }),
        );
        const provideNote =
          'provides "done" (task organize) cannot be checked: no `in`, no owned path, no declared files';
        const requireNote =
          'requires "organized_files" (task t1) has no provider — nothing produces it';
        expect(result.status).toBe("ok");
        expect(briefs).toHaveLength(2);
        for (const brief of briefs) {
          expect(brief).toContain(`contract: ${provideNote}`);
          expect(brief).toContain(`contract: ${requireNote}`);
          expect(brief).toContain("- [organize] other done");
        }
        expect(briefs[0]).toContain(
          "You may rely on: nothing from the other parts",
        );
        const lines = result.summary.split("\n");
        expect(lines[0]).toBe("2 tasks: 2 ok");
        expect(lines[1]).toBe(
          `contract: all 1 provide present; ${provideNote}; ${requireNote}`,
        );
        expect(lines[2]).toBe("- [t1] ok — One");
        // The title-less task is labelled by its id.
        expect(lines[3]).toBe("- [organize] ok — organize");
        const report = result.details.contract as {
          findings: unknown[];
          warnings: string[];
        };
        // The uncheckable provide got no finding — nothing was searched.
        expect(report.findings).toHaveLength(1);
        expect(report.warnings).toEqual([provideNote, requireNote]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses a malformed call with every problem named at once, before any worker runs", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({ runTurn }));
      const result = await tool.run(
        {
          tasks: [
            { id: "a" },
            { id: "b", instructions: "x", files: ["ok.js", 3] },
          ],
          contract: { provides: [{ task: "ghost", kind: "file", name: "x" }] },
        },
        ctx(),
      );
      expect(result.status).toBe("error");
      expect(result.summary).toContain(
        "validation: tasks[0].instructions must be a non-empty string; " +
          "tasks[1].files[1] must be a non-empty string; " +
          'contract.provides[0].task names unknown task "ghost"',
      );
      expect(runTurn).not.toHaveBeenCalled();
    });

    it("rejects a contract that does not bind the tasks, before any worker runs", async () => {
      const runTurn = vi.fn(async () => turnResult());
      const tool = buildFusionDelegateTool(deps({ runTurn }));
      const result = await tool.run(
        {
          tasks: TASKS,
          contract: { provides: [{ task: "ghost", kind: "file", name: "a" }] },
        },
        ctx(),
      );
      expect(result.status).toBe("error");
      expect(result.summary).toContain(
        'contract.provides[0].task names unknown task "ghost"',
      );
      expect(runTurn).not.toHaveBeenCalled();
    });
  });

  describe("waves ordered by the contract (F45)", () => {
    it("keeps the no-contract head unchanged, with optional-policy metadata but no wave plan", async () => {
      const tool = buildFusionDelegateTool(deps());
      const result = await tool.run({ tasks: TASKS, maxWorkers: 2 }, ctx());
      const rows = (result.details.tasks as WorkerTaskResult[]).map(
        // Both are wall-clock readings and neither is what this snapshot
        // is pinning.
        ({ durationMs: _ms, queueWaitMs: _q, ...row }) => row,
      );
      expect(result.summary).toMatchInlineSnapshot(`
        "2 tasks: 2 ok
        - [t1] ok — One
        - [t2] ok — Two
        timing: 0s wall, slowest [t1] 0s
        [t1] ok — One (1 steps, 0s, 0 tool calls, 0 errors)
        (the worker produced no reply)
        [t2] ok — Two (1 steps, 0s, 0 tool calls, 0 errors)
        (the worker produced no reply)"
      `);
      expect(result.details).not.toHaveProperty("waves");
      // Optional-policy provenance is additive, and is not a verification PASS.
      expect(result.details.checklistNotRequired).toBe(true);
      expect(result.details.checklistPassed).toBeUndefined();
      expect({ ...result.details, tasks: rows }).toMatchInlineSnapshot(`
        {
          "checklistNotRequired": true,
          "maxWorkers": 2,
          "outcome": "all_ok",
          "requestedWorkers": 2,
          "slotPoolSize": 4,
          "tasks": [
            {
              "id": "t1",
              "reply": "",
              "status": "ok",
              "stepCount": 1,
              "title": "One",
              "tools": {
                "byTool": {},
                "calls": 0,
                "errors": 0,
                "writes": 0,
              },
            },
            {
              "id": "t2",
              "reply": "",
              "status": "ok",
              "stepCount": 1,
              "title": "Two",
              "tools": {
                "byTool": {},
                "calls": 0,
                "errors": 0,
                "writes": 0,
              },
            },
          ],
        }
      `);
    });

    /** The live pipeline: `analyze` provides the manifest both others require. */
    const PIPELINE = [
      {
        id: "analyze",
        title: "Analyze",
        instructions: "a",
        files: ["manifest.json"],
      },
      { id: "organize", title: "Organize", instructions: "o" },
      { id: "index", title: "Index", instructions: "i" },
    ];
    const PIPELINE_CONTRACT = {
      provides: [{ task: "analyze", kind: "file", name: "manifest.json" }],
      requires: [
        { task: "organize", name: "manifest.json" },
        { task: "index", name: "manifest.json" },
      ],
    };

    /**
     * A fake `runTurn` that records, for each worker, which siblings had
     * already RESOLVED when it started, and how many were in flight.
     */
    function ordering(
      over: {
        reasonFor?: (taskId: string) => RunTurnResult["reason"];
        briefs?: string[];
      } = {},
    ) {
      const started: string[] = [];
      const resolvedBefore: Record<string, string[]> = {};
      const resolved: string[] = [];
      let inFlight = 0;
      let peakInFlight = 0;
      const runTurn: FusionDelegateDeps["runTurn"] = async (session, brief) => {
        const taskId = (
          session.metadata as { fusionWorker: { taskId: string } }
        ).fusionWorker.taskId;
        started.push(taskId);
        over.briefs?.push(brief);
        resolvedBefore[taskId] = [...resolved];
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        resolved.push(taskId);
        return turnResult({ reason: over.reasonFor?.(taskId) ?? "reply" });
      };
      return { runTurn, started, resolvedBefore, peak: () => peakInFlight };
    }

    it("runs the dependents in a second wave, after the provider's turn resolved", async () => {
      const fake = ordering();
      const tool = buildFusionDelegateTool(deps({ runTurn: fake.runTurn }));
      const result = await tool.run(
        { tasks: PIPELINE, contract: PIPELINE_CONTRACT, maxWorkers: 3 },
        ctx(),
      );
      expect(fake.started).toEqual(["analyze", "organize", "index"]);
      expect(fake.resolvedBefore.analyze).toEqual([]);
      expect(fake.resolvedBefore.organize).toEqual(["analyze"]);
      expect(fake.resolvedBefore.index).toEqual(["analyze"]);
      // The second wave still ran two wide.
      expect(fake.peak()).toBe(2);
      expect(result.status).toBe("ok");
      const lines = result.summary.split("\n");
      expect(lines[0]).toBe(
        "3 tasks in 2 waves (analyze → organize, index): 2 ok, 1 failed",
      );
      expect(result.details.waves).toEqual([
        ["analyze"],
        ["organize", "index"],
      ]);
      // Rows keep the caller's order, whatever wave each ran in.
      expect(
        (result.details.tasks as WorkerTaskResult[]).map((r) => r.id),
      ).toEqual(["analyze", "organize", "index"]);
    });

    it("bounds each wave by maxWorkers", async () => {
      const fake = ordering();
      const tool = buildFusionDelegateTool(deps({ runTurn: fake.runTurn }));
      const tasks = [
        ...PIPELINE,
        { id: "report", title: "Report", instructions: "r" },
      ];
      const contract = {
        ...PIPELINE_CONTRACT,
        requires: [
          ...PIPELINE_CONTRACT.requires,
          { task: "report", name: "manifest.json" },
        ],
      };
      const result = await tool.run({ tasks, contract, maxWorkers: 2 }, ctx());
      expect(fake.started).toEqual(["analyze", "organize", "index", "report"]);
      expect(fake.resolvedBefore.report).toContain("analyze");
      expect(fake.peak()).toBe(2);
      expect(result.details.waves).toEqual([
        ["analyze"],
        ["organize", "index", "report"],
      ]);
      expect(result.summary.split("\n")[0]).toBe(
        "4 tasks in 2 waves (analyze → organize, index, report): 3 ok, 1 failed",
      );
    });

    it("still runs a dependent whose provider did not deliver, warning it and the orchestrator", async () => {
      const briefs: string[] = [];
      const fake = ordering({
        briefs,
        reasonFor: (taskId) => (taskId === "analyze" ? "failed" : "reply"),
      });
      const tool = buildFusionDelegateTool(deps({ runTurn: fake.runTurn }));
      const result = await tool.run(
        { tasks: PIPELINE, contract: PIPELINE_CONTRACT },
        ctx(),
      );
      const organizeNote =
        "task organize depends on analyze, which ended failed";
      const indexNote = "task index depends on analyze, which ended failed";
      expect(fake.started).toEqual(["analyze", "organize", "index"]);
      // The provider's own brief carried no such note; the dependents' do.
      expect(briefs[0]).not.toContain("depends on");
      expect(briefs[1]).toContain(`contract: ${organizeNote}`);
      expect(briefs[1]).toContain(`contract: ${indexNote}`);
      expect(briefs[2]).toContain(`contract: ${indexNote}`);
      const lines = result.summary.split("\n");
      expect(lines[0]).toBe(
        "3 tasks in 2 waves (analyze → organize, index): 2 ok, 1 failed",
      );
      expect(lines[1]).toBe(
        `contract: 1 missing — [analyze] file manifest.json does not exist; ${organizeNote}; ${indexNote}`,
      );
      expect(
        (result.details.tasks as WorkerTaskResult[]).map((r) => r.status),
      ).toEqual(["failed", "ok", "ok"]);
      const report = result.details.contract as { warnings: string[] };
      expect(report.warnings).toEqual([organizeNote, indexNote]);
    });

    it("runs a cyclic contract as one wave, in the order given, with a warning", async () => {
      const briefs: string[] = [];
      const fake = ordering({ briefs });
      const tool = buildFusionDelegateTool(deps({ runTurn: fake.runTurn }));
      const result = await tool.run(
        {
          tasks: [
            { id: "a", title: "A", instructions: "a" },
            { id: "b", title: "B", instructions: "b" },
          ],
          contract: {
            provides: [
              { task: "a", kind: "file", name: "a.txt" },
              { task: "b", kind: "file", name: "b.txt" },
            ],
            requires: [
              { task: "a", name: "b.txt" },
              { task: "b", name: "a.txt" },
            ],
          },
          maxWorkers: 2,
        },
        ctx(),
      );
      const note =
        "requires form a cycle (a → b → a), so the tasks run in one wave in the order given";
      expect(fake.started).toEqual(["a", "b"]);
      expect(fake.peak()).toBe(2);
      for (const brief of briefs) expect(brief).toContain(`contract: ${note}`);
      expect(result.details.waves).toEqual([["a", "b"]]);
      const lines = result.summary.split("\n");
      expect(lines[0]).toBe("2 tasks in 1 wave (a, b): 2 ok");
      expect(lines[1]).toContain(note);
      expect(
        (result.details.contract as { warnings: string[] }).warnings,
      ).toEqual([note]);
    });

    it("orders nothing when the requires name nothing any task provides", async () => {
      const fake = ordering();
      const tool = buildFusionDelegateTool(deps({ runTurn: fake.runTurn }));
      const result = await tool.run(
        {
          tasks: PIPELINE,
          contract: { requires: [{ task: "organize", name: "ghost" }] },
          maxWorkers: 3,
        },
        ctx(),
      );
      expect(fake.peak()).toBe(3);
      expect(result.details).not.toHaveProperty("waves");
      expect(result.summary.split("\n")[0]).toBe("3 tasks: 2 ok, 1 failed");
    });
  });

  it("asks again when a later fan-out reaches outside what was approved", async () => {
    const asked: string[] = [];
    const scopes = new FanoutScopeRegistry();
    const d = deps({
      approvalRequired: true,
      approvals: {
        setSessionPolicy: () => {},
        clearSessionPolicy: () => {},
        fanoutScopes: scopes,
        request: async (req: { affectedResources?: readonly string[] }) => {
          asked.push((req.affectedResources ?? []).join(","));
          return { approved: true };
        },
      } as unknown as FusionDelegateDeps["approvals"],
    });
    const tool = buildFusionDelegateTool(d);
    await tool.run(
      {
        tasks: [
          { id: "t1", title: "One", instructions: "x", files: ["/repo/a.js"] },
        ],
      },
      ctx(),
    );
    await tool.run(
      {
        tasks: [
          {
            id: "t2",
            title: "Two",
            instructions: "x",
            files: ["/elsewhere/b.js"],
          },
        ],
      },
      ctx(),
    );
    expect(asked).toHaveLength(2);
  });
});

describe("fusion.delegate — contract inputs (F51)", () => {
  it("declares the contract's inputs to every worker session before its turn and clears them after", async () => {
    const log: string[] = [];
    const tool = buildFusionDelegateTool(
      deps({
        declaredInputs: {
          declare: (sessionId, paths) =>
            log.push(`declare ${sessionId} ${paths.join(",")}`),
          clear: (sessionId) => log.push(`clear ${sessionId}`),
        },
        runTurn: async (session, userMessage) => {
          log.push(
            `turn ${session.id} ${userMessage.includes("never replace; os.fs.write on one is refused):\n- sales.csv") ? "briefed" : "unbriefed"}`,
          );
          return turnResult();
        },
      }),
    );
    const result = await tool.run(
      { tasks: TASKS, contract: { inputs: ["sales.csv", "js/*.js"] } },
      ctx(),
    );
    expect(result.status).toBe("ok");
    const input = join("/repo", "sales.csv");
    for (const id of ["s-w-1", "s-w-2"]) {
      const declared = log.indexOf(`declare ${id} ${input}`);
      const turned = log.indexOf(`turn ${id} briefed`);
      const cleared = log.indexOf(`clear ${id}`);
      expect(declared).toBeGreaterThanOrEqual(0);
      expect(turned).toBeGreaterThan(declared);
      expect(cleared).toBeGreaterThan(turned);
    }
    expect(log).toHaveLength(6);
  });
});
