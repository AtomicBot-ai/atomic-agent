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

  it("falls back to the configured `workers` when the call names none", async () => {
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 8 } }),
    );
    const result = await tool.run({ tasks: sixTasks() }, ctx());
    expect(result.details.maxWorkers).toBe(3);
    expect(result.details.requestedWorkers).toBe(3);
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
      }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.details.maxWorkers).toBe(6);
    expect(result.details.slotPoolSize).toBeUndefined();
    expect(result.summary).not.toContain("localModels.managed.parallel");
  });

  it("names both numbers and the knob when the pool is the binding constraint", async () => {
    // The orchestrator is the party that can adapt, so the note has to
    // reach its tool result and carry all three facts: what was wanted,
    // what actually ran at once, and the key that moves the second one.
    const tool = buildFusionDelegateTool(
      deps({ slotManager: { poolSize: () => 2 } }),
    );
    const result = await tool.run({ tasks: sixTasks(), maxWorkers: 6 }, ctx());
    expect(result.summary).toContain("6 workers were wanted");
    expect(result.summary).toContain("2 request slots");
    expect(result.summary).toContain("only 2 ran at a time");
    expect(result.summary).toContain("localModels.managed.parallel");
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
    const result = await tool.run(
      { tasks: TASKS },
      ctx({ signal: controller.signal }),
    );
    expect(result.status).toBe("ok");
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
});
