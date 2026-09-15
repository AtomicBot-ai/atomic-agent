import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(result.summary.split("\n")[1]).toBe("- [fix_main_sync] ok — fix main sync");
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows[0]).toMatchObject({ id: "fix_main_sync", title: "fix main sync" });
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
                timing: { promptMs: 1, predictedMs: 1, promptTokens: 1, predictedTokens: 1 },
                cacheHitTokens: 0,
                slotId: 0,
                modelId: "small",
                usage: { promptTokens: 1_000_000, completionTokens: 250_000, totalTokens: 1_250_000 },
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
    expect(seen[0]).toMatchObject({ reasoningEffort: "low", maxOutputTokens: 12_000 });
    expect(result.summary).toContain("cloud spend $4.00 on small (2,000,000 in / 500,000 out)");
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
    const task = { id: "t1", title: "One", instructions: "Do one", files: ["a.js", "b.js"] };
    await capture({}).run({ tasks: [task] }, ctx());
    expect(limits[0]).toBeGreaterThanOrEqual(600_000);
    expect(limits[0]).toBeLessThan(2_700_000);
    await capture({ workerSupportsSlotAffinity: () => false }).run({ tasks: [task] }, ctx());
    expect(limits[1]).toBe(2_700_000);
    await capture({ localTokensPerSecond: () => null }).run({ tasks: [task] }, ctx());
    expect(limits[2]).toBe(2_700_000);
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
    const result = await buildFusionDelegateTool(deps()).run({ tasks: TASKS }, ctx());
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
                  summary: "⚠ replaced the user's file `sales.csv` (2,401 lines → 9); …",
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
        { task: "t1", kind: "command", cmd: "node", args: ["--check", "js/ship.js"] },
        { task: "t2", kind: "page", path: "index.html", checks: ["no errors"] },
        { kind: "command", cmd: "npm", args: ["test"] },
      ],
    };

    function fixture(): string {
      const dir = mkdtempSync(join(tmpdir(), "fusion-delegate-contract-"));
      mkdirSync(join(dir, "js"));
      writeFileSync(join(dir, "js", "ship.js"), "HD.Ship = class {};");
      writeFileSync(join(dir, "index.html"), '<button id="launch-btn"></button>');
      return dir;
    }

    it("briefs every worker with it, checks presence on disk and runs the checks through the injected runner", async () => {
      const dir = fixture();
      try {
        const briefs: string[] = [];
        const runChecks = vi.fn(
          async (specs: readonly Record<string, unknown>[], runCtx: { workingDir: string }) => ({
            ok: false,
            results: specs.map((spec) =>
              spec.kind === "page"
                ? { ok: false, summary: "no errors: 1 pageerror — ReferenceError: p is not defined" }
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
        expect(briefs[0]).toContain("CONTRACT — the interface between the parts");
        expect(briefs[0]).toContain("You provide: symbol HD.Ship in js/ship.js; symbol HD.Ship.reset in js/ship.js");
        expect(briefs[1]).toContain("You may rely on: HD.Ship (symbol from t1 in js/ship.js)");

        // The runner sees the specs without their `task` key, and the call's cwd.
        expect(runChecks).toHaveBeenCalledTimes(1);
        expect(runChecks.mock.calls[0]![0]).toEqual([
          { kind: "command", cmd: "node", args: ["--check", "js/ship.js"] },
          { kind: "page", path: "index.html", checks: ["no errors"] },
          { kind: "command", cmd: "npm", args: ["test"] },
        ]);
        expect(runChecks.mock.calls[0]![1].workingDir).toBe(dir);

        // Presence: `HD.Ship.reset` was never written; the id is spelled the other way.
        const lines = result.summary.split("\n");
        expect(lines[0]).toBe("2 tasks: 1 ok, 1 failed");
        expect(lines[1]).toBe(
          "contract: 2 missing — [t1] symbol HD.Ship.reset not in js/ship.js; [t2] id btn-launch not in index.html; call-level checks: 1 of 1 passed",
        );
        expect(lines[2]).toBe(
          "- [t1] ok — One — checks: 1 of 1 passed — contract: symbol HD.Ship.reset not in js/ship.js",
        );
        // The task whose declared check failed is `failed`, with the verdict as its error.
        expect(lines[3]).toBe(
          "- [t2] failed — Two — error: checks: no errors: 1 pageerror — ReferenceError: p is not defined — checks: 1 of 1 failed — contract: id btn-launch not in index.html",
        );
        const rows = result.details.tasks as WorkerTaskResult[];
        expect(rows.map((r) => r.status)).toEqual(["ok", "failed"]);
        const report = result.details.contract as { findings: unknown[]; checks: unknown[] };
        expect(report.findings).toHaveLength(3);
        expect(report.checks).toHaveLength(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports declared checks as not run when no runner is wired, and never fails a task on them", async () => {
      const dir = fixture();
      try {
        const tool = buildFusionDelegateTool(deps({ workingDir: dir }));
        const result = await tool.run(
          { tasks: TASKS, contract: CONTRACT },
          ctx({ workingDir: dir }),
        );
        expect(result.summary.split("\n")[1]).toContain("3 checks not run — no check runner is wired");
        const rows = result.details.tasks as WorkerTaskResult[];
        expect(rows.map((r) => r.status)).toEqual(["ok", "ok"]);
        expect(rows[0]).not.toHaveProperty("checks");
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
                { task: "t1", kind: "symbol", name: "HD.Ship", in: "js/ship.js" },
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
        expect(briefs[0]).toContain("You may rely on: nothing from the other parts");
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
      expect(result.summary).toContain('contract.provides[0].task names unknown task "ghost"');
      expect(runTurn).not.toHaveBeenCalled();
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
