import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FanoutScopeRegistry } from "../../approval/fanout-scope.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import { createEmptySessionState, type SessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { StructuredLogger } from "../../tracing/structured-logger.js";
import type { ToolContext } from "../tool-registry.js";
import {
  buildFusionDelegateTool,
  type FusionDelegateDeps,
} from "./fusion-delegate.js";
import { FusionRunStore, type FusionRunCheckpoint } from "./run-checkpoint.js";
import {
  CARRIED_NOTE,
  describeResumableRun,
  planResume,
  readResumeRequest,
  renderResumeRequest,
} from "./run-resume.js";
import { FusionTurnBudget } from "./turn-budget.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

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

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  workingDir: "/repo",
  sessionId: "s-parent",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...over,
});

const taskIdOf = (session: SessionState): string =>
  (session.metadata as { fusionWorker?: { taskId?: string } }).fusionWorker
    ?.taskId ?? "?";

function deps(
  over: Partial<FusionDelegateDeps>,
  onTurn: (taskId: string) => void = () => {},
): FusionDelegateDeps & { ran: string[] } {
  let minted = 0;
  const d = {
    ran: [] as string[],
    runTurn: async (session: SessionState) => {
      const id = taskIdOf(session);
      d.ran.push(id);
      onTurn(id);
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
    ...over,
  } as FusionDelegateDeps & { ran: string[] };
  return d;
}

const TASKS = [
  { id: "t1", title: "One", instructions: "do one" },
  { id: "t2", title: "Two", instructions: "do two" },
  { id: "t3", title: "Three", instructions: "do three" },
];

/** t2 needs what t1 provides: two waves. */
const ORDERED = {
  tasks: TASKS.slice(0, 2),
  contract: {
    provides: [{ task: "t1", kind: "other", name: "done" }],
    requires: [{ task: "t2", name: "done" }],
  },
};

function row(id: string, over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({ id, title: id, reason: "reply", stepCount: 1, durationMs: 5 }),
    reply: `reply of ${id}`,
    ...over,
  };
}

describe("resuming a fusion run (ATO-617)", () => {
  let dir: string;
  let store: FusionRunStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-resume-"));
    store = new FusionRunStore({ dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A run of TASKS cut off with `done` finished and `effects` mid-command. */
  function cutOff(
    done: string[],
    effects: string[] = [],
    spentUsd = 0,
  ): FusionRunCheckpoint {
    const run = store.start({
      sessionId: "s-parent",
      workingDir: "/repo",
      originalRequest: "build the thing",
      args: { tasks: TASKS },
      tasks: TASKS,
      waveCount: 1,
    });
    for (const id of done) run.recordTask(row(id), spentUsd / Math.max(1, done.length));
    for (const id of effects) run.noteTool(id, "os.shell.run");
    run.finish("interrupted");
    return store.load(run.runId)!;
  }

  describe("the checkpoint during a run", () => {
    it("is written after a task finishes and after its wave", async () => {
      // A run in flight is never offered, so read its file directly.
      const readFile = (): FusionRunCheckpoint | undefined => {
        const [file] = readdirSync(dir).filter((f) => f.endsWith(".json"));
        return file === undefined
          ? undefined
          : (store.load(file.replace(/\.json$/, "")) ?? undefined);
      };
      let seenInWave2: FusionRunCheckpoint | undefined;
      const d = deps({ runCheckpoints: store }, (taskId) => {
        if (taskId === "t2") seenInWave2 = readFile();
      });
      await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(seenInWave2).toBeDefined();
      expect(seenInWave2!.tasks.find((t) => t.id === "t1")!.result?.status).toBe("ok");
      expect(seenInWave2!.tasks.find((t) => t.id === "t2")!.result).toBeUndefined();
      expect(seenInWave2!.wavesDone).toBe(1);
      expect(seenInWave2!.waveCount).toBe(2);
    });

    it("is deleted when the run completes", async () => {
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(result.status).toBe("ok");
      expect(store.listResumable()).toEqual([]);
      expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    });

    it("is kept, and offered, when the turn is stopped", async () => {
      const controller = new AbortController();
      const d = deps({ runCheckpoints: store }, (taskId) => {
        if (taskId === "t1") controller.abort();
      });
      await buildFusionDelegateTool(d).run(ORDERED, ctx({ signal: controller.signal }));
      const offered = store.listResumable("s-parent");
      expect(offered).toHaveLength(1);
      expect(offered[0]!.state).toBe("interrupted");
    });

    it("writes nothing without a store", async () => {
      const d = deps({});
      await buildFusionDelegateTool(d).run(ORDERED, ctx());
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  describe("planResume", () => {
    it("carries finished tasks and re-runs the rest", () => {
      const plan = planResume(cutOff(["t1"]));
      expect(plan.carried.map((r) => r.id)).toEqual(["t1"]);
      expect(plan.carried[0]!.notes).toContain(CARRIED_NOTE);
      expect(plan.rerun).toEqual(["t2", "t3"]);
      expect(plan.needsConfirmation).toEqual([]);
    });

    it("re-runs a task the stop left cancelled", () => {
      const run = store.start({
        sessionId: "s-parent", workingDir: "/repo", args: { tasks: TASKS }, tasks: TASKS, waveCount: 1,
      });
      run.recordTask(row("t1", { status: "cancelled" }));
      run.finish("interrupted");
      expect(planResume(store.load(run.runId)!).rerun).toContain("t1");
    });

    it("holds a task with side effects for the person's yes", () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const plan = planResume(checkpoint);
      expect(plan.rerun).toEqual(["t3"]);
      expect(plan.needsConfirmation.map((r) => r.id)).toEqual(["t2"]);
      expect(plan.needsConfirmation[0]!.status).toBe("needs_orchestrator");
      expect(plan.needsConfirmation[0]!.error).toContain("os.shell.run");
      expect(plan.needsConfirmation[0]!.error).toContain(`"confirm":["t2"]`);
      expect(planResume(checkpoint, ["t2"]).rerun).toEqual(["t2", "t3"]);
    });

    it("carries the spend recorded so far", () => {
      expect(planResume(cutOff(["t1"], [], 2)).carriedSpendUsd).toBeCloseTo(2);
    });
  });

  describe("fusion.delegate { resume }", () => {
    it("re-dispatches only the unfinished tasks and reports the rest from the checkpoint", async () => {
      const checkpoint = cutOff(["t1"]);
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(d.ran.sort()).toEqual(["t2", "t3"]);
      expect(result.status).toBe("ok");
      const details = result.details as {
        tasks: WorkerTaskResult[];
        resume: { carried: string[]; rerun: string[] };
      };
      expect(details.resume.carried).toEqual(["t1"]);
      expect(details.resume.rerun).toEqual(["t2", "t3"]);
      expect(details.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
      expect(details.tasks[0]!.reply).toBe("reply of t1");
      expect(result.summary).toContain(`Resumed run ${checkpoint.runId}`);
      // Completed now: nothing left to offer.
      expect(store.listResumable()).toEqual([]);
    });

    it("does not re-run a task with side effects without confirmation", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({ runCheckpoints: store });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(d.ran).toEqual(["t3"]);
      const details = result.details as {
        tasks: WorkerTaskResult[];
        resume: { needsConfirmation: string[] };
      };
      expect(details.resume.needsConfirmation).toEqual(["t2"]);
      expect(details.tasks.find((t) => t.id === "t2")!.status).toBe("needs_orchestrator");
    });

    it("re-runs it once the person confirmed", async () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const d = deps({ runCheckpoints: store });
      await buildFusionDelegateTool(d).run(
        { resume: checkpoint.runId, confirm: ["t2"] },
        ctx(),
      );
      expect(d.ran.sort()).toEqual(["t2", "t3"]);
    });

    it("counts the spend before the restart toward the turn's cap", async () => {
      const checkpoint = cutOff(["t1"], [], 5);
      const turnBudget = new FusionTurnBudget();
      turnBudget.begin("s-parent");
      const d = deps({
        runCheckpoints: store,
        turnBudget,
        resolveRunMode: () => mode({ turnBudgetUsd: 3 }),
      });
      const result = await buildFusionDelegateTool(d).run({ resume: checkpoint.runId }, ctx());
      expect(result.status).toBe("error");
      expect(result.details?.reason).toBe("turn-budget");
      expect(d.ran).toEqual([]);
      expect(turnBudget.workerSpend("s-parent")).toBeCloseTo(5);
    });

    it("refuses a run of another session, an unknown id and a malformed call", async () => {
      const checkpoint = cutOff(["t1"]);
      const tool = buildFusionDelegateTool(deps({ runCheckpoints: store }));
      expect(
        (await tool.run({ resume: checkpoint.runId }, ctx({ sessionId: "s-other" }))).details?.reason,
      ).toBe("resume-unknown");
      expect((await tool.run({ resume: "fr-nope" }, ctx())).details?.reason).toBe("resume-unknown");
      expect((await tool.run({ resume: 7 }, ctx())).status).toBe("error");
    });

    it("refuses a resume without a store", async () => {
      const result = await buildFusionDelegateTool(deps({})).run({ resume: "fr-x" }, ctx());
      expect(result.details?.reason).toBe("resume-unknown");
    });
  });

  describe("the words", () => {
    it("reads resume and confirm off the call", () => {
      expect(readResumeRequest({ tasks: [] })).toBeNull();
      expect(readResumeRequest({ resume: " fr-1 ", confirm: ["t2"] })).toEqual({ runId: "fr-1", confirm: ["t2"] });
      expect(typeof readResumeRequest({ confirm: ["t2"] })).toBe("string");
      expect(typeof readResumeRequest({ resume: "fr-1", confirm: "t2" })).toBe("string");
    });

    it("says what is done and what is left", () => {
      const checkpoint = cutOff(["t1"], ["t2"]);
      const line = describeResumableRun(checkpoint);
      expect(line).toContain("1 of 3 tasks done");
      expect(line).toContain("2 left");
      expect(line).toContain("1 ran commands");
      const message = renderResumeRequest(checkpoint);
      expect(message).toContain(`{"resume":"${checkpoint.runId}"}`);
      expect(message).toContain("build the thing");
    });
  });
});
