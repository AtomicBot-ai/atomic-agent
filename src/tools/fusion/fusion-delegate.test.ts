import { describe, expect, it, vi } from "vitest";

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
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
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
      deps({ runTurn, resolveRunMode: () => fusionMode({ effective: "cloud" }) }),
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

  it("caps concurrency by the smallest of maxWorkers, task count and pool", async () => {
    const four = [
      ...TASKS,
      { id: "t3", title: "Three", instructions: "Do three" },
      { id: "t4", title: "Four", instructions: "Do four" },
    ];
    const byArgs = buildFusionDelegateTool(deps());
    expect((await byArgs.run({ tasks: four, maxWorkers: 2 }, ctx())).details.maxWorkers).toBe(2);
    // Run mode's `workers` (3) when the call names none.
    expect((await byArgs.run({ tasks: four }, ctx())).details.maxWorkers).toBe(3);
    // Task count.
    expect((await byArgs.run({ tasks: TASKS }, ctx())).details.maxWorkers).toBe(2);
    // Slot pool.
    const smallPool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 1 } }),
    );
    expect((await smallPool.run({ tasks: four }, ctx())).details.maxWorkers).toBe(1);
  });

  it("ignores the slot pool for a worker leg without slot affinity", async () => {
    const tool = buildFusionDelegateTool(
      deps({
        slotManager: { poolSize: () => 1 },
        workerSupportsSlotAffinity: () => false,
      }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.details.maxWorkers).toBe(2);
    expect(result.summary).not.toContain("localModels.managed.parallel");
  });

  it("names the parallel knob when a one-slot server serialised the fan-out", async () => {
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 1 } }),
    );
    const result = await tool.run({ tasks: TASKS }, ctx());
    expect(result.summary).toContain("localModels.managed.parallel");
    // Not a note when there was nothing to parallelise in the first place.
    const solo = await tool.run({ tasks: [TASKS[0]!] }, ctx());
    expect(solo.summary).not.toContain("localModels.managed.parallel");
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
    const rows = result.details.tasks as WorkerTaskResult[];
    expect(rows.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(result.summary).toContain("[t1] failed");
    expect(result.summary).toContain("[t2] ok");
  });

  it("survives an aborted orchestrator turn without throwing", async () => {
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
    const result = await tool.run({ tasks: TASKS }, ctx({ signal: controller.signal }));
    expect(result.status).toBe("ok");
    expect((result.details.tasks as WorkerTaskResult[]).every((r) => r.status === "cancelled")).toBe(
      true,
    );
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
});
