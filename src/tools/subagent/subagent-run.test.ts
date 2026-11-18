import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { requireFsApproval } from "../os/fs/fs-require-approval.js";

import type { AgentLoopEvent, RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  FUSION_WORKER_METADATA_KEY,
  createFusionWorkerSession,
  readFusionWorkerMeta,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { SessionState } from "../../session/session-state.js";
import type { ToolContext } from "../tool-registry.js";
import {
  SUBAGENT_MAX_CHILDREN_PER_CALL,
  SUBAGENT_MAX_CHILDREN_PER_TURN,
  SUBAGENT_MAX_DEPTH,
  SubagentTurnLedger,
  buildSubagentRunTool,
  type SubagentRunDeps,
} from "./index.js";
import {
  SUBAGENT_CEILING_INSTRUCTION,
  SUBAGENT_UNPRICED_NOTE,
  SUBAGENT_APPROVAL_REFUSED,
  SUBAGENT_OPERATOR_ONLY_REFUSED,
  subagentRefusalFor,
} from "./subagent-run.js";

type RunTurnCall = {
  session: SessionState;
  userMessage: string;
  options: Parameters<SubagentRunDeps["runTurn"]>[2];
};

function mode(over: Partial<ResolvedRunMode> = {}): ResolvedRunMode {
  return {
    effective: "local",
    workerMaxSteps: 6,
    workerTimeoutMs: 60_000,
    cloudWorkers: 4,
    ...over,
  } as unknown as ResolvedRunMode;
}

function harness(over: Partial<SubagentRunDeps> = {}): {
  deps: SubagentRunDeps;
  calls: RunTurnCall[];
  events: Array<{ sessionId: string; event: AgentLoopEvent }>;
} {
  const calls: RunTurnCall[] = [];
  const events: Array<{ sessionId: string; event: AgentLoopEvent }> = [];
  const deps: SubagentRunDeps = {
    runTurn: async (session, userMessage, options) => {
      calls.push({ session, userMessage, options });
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({
        type: "llm_event",
        event: { type: "assistant_reply", text: `found it for ${session.id}` },
      });
      const result: RunTurnResult = {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: "reply",
        stepCount: 2,
      };
      return result;
    },
    createEphemeralSession: (meta: FusionWorkerMeta, dir?: string) =>
      createFusionWorkerSession({ workingDir: dir ?? "/repo", meta }),
    approvals: {
      setSessionPolicy: () => {},
      clearSessionPolicy: () => {},
    },
    emitEvent: (sessionId, event) => events.push({ sessionId, event }),
    workingDir: "/repo",
    resolveRunMode: () => mode(),
    resolveSessionLeg: (pinned) => ({
      providerId: pinned ?? "session-provider",
      model: "session-model",
    }),
    workerSupportsSlotAffinity: () => false,
    approvalRequired: false,
    outputCharCap: 8_000,
    ...over,
  };
  return { deps, calls, events };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/repo",
    sessionId: "s-operator",
    stepIndex: 1,
    signal: new AbortController().signal,
    ...over,
  };
}

const ONE_TASK = {
  tasks: [{ id: "find", instructions: "Find where tokens are checked." }],
};

function workerStamp(depth: unknown): Record<string, unknown> {
  return {
    [FUSION_WORKER_METADATA_KEY]: {
      parentSessionId: "s-operator",
      taskId: "t",
      depth,
    },
  };
}

describe("subagent.run depth guard (ATO-1670)", () => {
  it("allows only depth 0 to call it", () => {
    expect(SUBAGENT_MAX_DEPTH).toBe(1);
  });

  it("refuses from a worker session stamped depth 1, before any work", async () => {
    const { deps, calls } = harness({
      readSessionMetadata: () => workerStamp(1),
    });
    const result = await buildSubagentRunTool(deps).run(
      ONE_TASK,
      ctx({ sessionId: "s-w-child" }),
    );
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "depth", depth: 1 });
    expect(calls).toHaveLength(0);
  });

  it("refuses on the session's depth stamp alone, whatever the id looks like", async () => {
    // The id has no worker prefix: only the session data says it is a
    // subagent, so this passes only if the stamp is really read.
    const { deps, calls } = harness({
      readSessionMetadata: (id) => (id === "s-stamped" ? workerStamp(1) : undefined),
    });
    const result = await buildSubagentRunTool(deps).run(
      ONE_TASK,
      ctx({ sessionId: "s-stamped" }),
    );
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "depth" });
    expect(calls).toHaveLength(0);
  });

  it("fails closed: a worker id with a broken or missing stamp is still refused", async () => {
    for (const metadata of [
      undefined,
      { [FUSION_WORKER_METADATA_KEY]: "garbage" },
      { [FUSION_WORKER_METADATA_KEY]: { taskId: "t" } },
    ]) {
      const { deps, calls } = harness({ readSessionMetadata: () => metadata });
      const result = await buildSubagentRunTool(deps).run(
        ONE_TASK,
        ctx({ sessionId: "s-w-broken" }),
      );
      expect(result.status).toBe("error");
      expect(result.details).toMatchObject({ reason: "depth" });
      expect(calls).toHaveLength(0);
    }
  });
});

describe("subagent.run from a real session (ATO-1670)", () => {
  it("runs one subagent turn, stamps its session depth 1 and runs it under the subagent origin", async () => {
    const { deps, calls, events } = harness();
    const result = await buildSubagentRunTool(deps).run(ONE_TASK, ctx());

    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    const child = calls[0]!;
    expect(child.session.id.startsWith("s-w-")).toBe(true);
    expect(readFusionWorkerMeta(child.session.metadata)).toEqual({
      parentSessionId: "s-operator",
      taskId: "find",
      depth: 1,
    });
    expect(child.options.origin).toBe("subagent");
    // On the session's own model, with the worker posture.
    expect(child.options.providerId).toBe("session-provider");
    expect(child.options.toolRole).toBe("builder");
    expect(child.options.toolFilter?.("subagent.run")).toBe(false);
    expect(child.options.toolFilter?.("fusion.delegate")).toBe(false);
    expect(child.userMessage).toContain("Find where tokens are checked.");
    expect(result.details).toMatchObject({ depth: 1, origin: "subagent" });
    expect(result.summary).toContain("found it for");
    // Its row reaches the caller's feed, not the subagent's own session.
    expect(events.some((e) => e.event.type === "fusion_worker")).toBe(true);
    expect(events.every((e) => e.sessionId === "s-operator")).toBe(true);
  });

  it("runs on the step's pinned provider when the step has one", async () => {
    const { deps, calls } = harness();
    await buildSubagentRunTool(deps).run(ONE_TASK, ctx({ providerId: "pinned-provider" }));
    expect(calls[0]!.options.providerId).toBe("pinned-provider");
  });

  it("runs on the turn's own model when the turn asked its link for one, and the row names it", async () => {
    // The desktop's per-project model reaches the turn as
    // runTurn({ providerId, model }); the link's default is another.
    const { deps, calls } = harness({
      resolveSessionLeg: (pinned) => ({
        providerId: pinned ?? "session-provider",
        model: "default-model",
      }),
    });
    const result = await buildSubagentRunTool(deps).run(
      ONE_TASK,
      ctx({ providerId: "cloud-x", model: "project-model" }),
    );
    expect(result.status).toBe("ok");
    expect(calls[0]!.options.providerId).toBe("cloud-x");
    expect(calls[0]!.options.model).toBe("project-model");
    const rows = (result.details as { tasks: Array<{ model?: string }> }).tasks;
    expect(rows[0]!.model).toBe("project-model");
  });

  it("refuses in Fusion mode and points at fusion.delegate", async () => {
    const { deps, calls } = harness({
      resolveRunMode: () => mode({ effective: "fusion" }),
    });
    const result = await buildSubagentRunTool(deps).run(ONE_TASK, ctx());
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "fusion" });
    expect(result.summary).toContain("fusion.delegate");
    expect(calls).toHaveLength(0);
  });
});

describe("subagent.run child limits (ATO-1670)", () => {
  const tasks = (n: number, prefix = "t") =>
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}${i}`,
      instructions: `Part ${i}.`,
    }));

  it("uses the existing caps: 4 per call, 24 per turn", () => {
    expect(SUBAGENT_MAX_CHILDREN_PER_CALL).toBe(4);
    expect(SUBAGENT_MAX_CHILDREN_PER_TURN).toBe(24);
  });

  it("refuses a call over the per-call cap with a clear error", async () => {
    const { deps, calls } = harness();
    const result = await buildSubagentRunTool(deps).run(
      { tasks: tasks(SUBAGENT_MAX_CHILDREN_PER_CALL + 1) },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain(
      `at most ${SUBAGENT_MAX_CHILDREN_PER_CALL} subagents per call`,
    );
    expect(calls).toHaveLength(0);
  });

  it("runs a full call side by side", async () => {
    const { deps, calls } = harness();
    const result = await buildSubagentRunTool(deps).run(
      { tasks: tasks(SUBAGENT_MAX_CHILDREN_PER_CALL) },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(SUBAGENT_MAX_CHILDREN_PER_CALL);
  });

  it("refuses a call that would take the turn over the per-turn cap, and counts afresh next turn", async () => {
    const turnLedger = new SubagentTurnLedger();
    turnLedger.record(
      "s-operator",
      { turnId: "turn-1", stepIndex: 1 },
      SUBAGENT_MAX_CHILDREN_PER_TURN - 2,
    );
    const { deps, calls } = harness({ turnLedger });
    const tool = buildSubagentRunTool(deps);

    const over = await tool.run({ tasks: tasks(3) }, ctx({ turnId: "turn-1", stepIndex: 2 }));
    expect(over.status).toBe("error");
    expect(over.details).toMatchObject({
      reason: "children-per-turn",
      already: SUBAGENT_MAX_CHILDREN_PER_TURN - 2,
      maxChildrenPerTurn: SUBAGENT_MAX_CHILDREN_PER_TURN,
    });
    expect(calls).toHaveLength(0);

    // Two still fit this turn.
    const fits = await tool.run({ tasks: tasks(2) }, ctx({ turnId: "turn-1", stepIndex: 3 }));
    expect(fits.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(
      turnLedger.childrenThisTurn("s-operator", { turnId: "turn-1", stepIndex: 4 }),
    ).toBe(SUBAGENT_MAX_CHILDREN_PER_TURN);

    // The next turn counts afresh, even though its first call lands at
    // a higher step than the last call of the turn before.
    const nextTurn = await tool.run(
      { tasks: tasks(3, "n") },
      ctx({ turnId: "turn-2", stepIndex: 5 }),
    );
    expect(nextTurn.status).toBe("ok");
    expect(calls).toHaveLength(5);
  });

  it("does not carry a turn's count into the next turn whose first call is at a higher step", async () => {
    // Turn 1 called at step 0; turn 2's first call is at step 1. Read
    // from step edges alone that is one turn, and the call is refused.
    const turnLedger = new SubagentTurnLedger();
    turnLedger.record("s-operator", { turnId: "turn-1", stepIndex: 0 }, SUBAGENT_MAX_CHILDREN_PER_TURN);
    const { deps, calls } = harness({ turnLedger });
    const result = await buildSubagentRunTool(deps).run(
      ONE_TASK,
      ctx({ turnId: "turn-2", stepIndex: 1 }),
    );
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});

describe("subagent.run profiles (ATO-1670)", () => {
  it("applies the explore profile: its instructions in the brief and only its read tools", async () => {
    const { deps, calls } = harness();
    const result = await buildSubagentRunTool(deps).run(
      {
        tasks: [
          { id: "map", profile: "explore", instructions: "Map the auth code." },
        ],
      },
      ctx(),
    );
    expect(result.status).toBe("ok");
    const filter = calls[0]!.options.toolFilter!;
    expect(filter("os.fs.read")).toBe(true);
    expect(filter("os.fs.grep")).toBe(true);
    expect(filter("os.fs.write")).toBe(false);
    expect(filter("os.shell.run")).toBe(false);
    expect(filter("subagent.run")).toBe(false);
    expect(calls[0]!.userMessage).toContain("You are an explorer");
    expect(result.details).toMatchObject({
      profiles: [{ task: "map", profile: "explore", source: "builtin" }],
    });
    // No role models configured: the session's own model.
    expect(calls[0]!.options.providerId).toBe("session-provider");
  });

  it("runs on the role model a profile names when one is configured, as fusion.delegate resolves it", async () => {
    const { deps, calls } = harness({
      resolveRunMode: () =>
        mode({
          roles: {
            byRole: {
              explore: { providerId: "explore-provider", model: "explore-model", local: false },
            },
            mixLocalModels: false,
            localLegProviderIds: [],
          },
        }),
    });
    const result = await buildSubagentRunTool(deps).run(
      { tasks: [{ id: "map", profile: "explore", instructions: "Map it." }] },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(calls[0]!.options.providerId).toBe("explore-provider");
    expect(result.details?.tasks).toMatchObject([
      { id: "map", model: "explore-model", modelRole: "explore" },
    ]);
  });

  it("refuses an unknown profile with a clear error naming the ones there are", async () => {
    const { deps, calls } = harness();
    const result = await buildSubagentRunTool(deps).run(
      { tasks: [{ id: "x", profile: "nope", instructions: "Do it." }] },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.details).toMatchObject({ reason: "unknown-profile" });
    expect(result.summary).toContain('profile "nope"');
    expect(result.summary).toContain("`explore`");
    expect(calls).toHaveLength(0);
  });
});

describe("subagent.run writes (ATO-1670)", () => {
  function gateApproving(): { gate: ApprovalGate; prompts: ApprovalRequest[] } {
    const prompts: ApprovalRequest[] = [];
    const gate: ApprovalGate = new ApprovalGate({
      level: 1,
      emit: (req) => {
        prompts.push(req);
        queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
      },
    });
    return { gate, prompts };
  }

  /** What a subagent's write of `path` gets from the gate, as `os.fs.write` asks. */
  const writeAs = async (
    gate: ApprovalGate,
    sessionId: string,
    workingDir: string,
    path: string,
  ): Promise<string> => {
    try {
      await requireFsApproval(
        { approvals: gate, approvalRequired: true },
        { kind: "write", paths: [path], sessionId, tool: "os.fs.write", reason: `write ${path}`, workingDir },
        new AbortController().signal,
      );
      return "written";
    } catch (err) {
      return err instanceof ApprovalDeniedError ? (err.reason ?? err.message) : String(err);
    }
  };

  it("asks the person once for declared files at level 1, then lets the subagents write there", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subagent-writes-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "subagent-elsewhere-"));
    try {
      mkdirSync(join(repo, "src"));
      const { gate, prompts } = gateApproving();
      const writes: string[] = [];
      const { deps } = harness({
        approvals: gate,
        approvalRequired: true,
        workingDir: repo,
        runTurn: async (session) => {
          writes.push(await writeAs(gate, session.id, repo, join(repo, "src", "a.ts")));
          writes.push(await writeAs(gate, session.id, repo, join(elsewhere, "b.ts")));
          return {
            session: createEmptySessionState({ id: "s-x", workingDir: repo }),
            reason: "reply",
            stepCount: 1,
          };
        },
      });
      const result = await buildSubagentRunTool(deps).run(
        {
          tasks: [
            { id: "fix_a", instructions: "Fix the bug in src/a.ts.", files: ["src/a.ts"] },
            { id: "fix_c", instructions: "Fix the bug in src/c.ts.", files: ["src/c.ts"] },
          ],
        },
        ctx({ workingDir: repo }),
      );
      expect(result.status).not.toBe("error");
      // One question for the whole call, under the fan-out category.
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ tool: "subagent.run", category: "fusion_fanout" });
      // Inside the declared directory: written unasked. Outside: refused
      // with the subagent's own text, which names no orchestrator.
      expect(writes.filter((w) => w === "written")).toHaveLength(2);
      const refused = writes.filter((w) => w !== "written");
      expect(refused).toHaveLength(2);
      for (const text of refused) {
        expect(text).toBe(SUBAGENT_APPROVAL_REFUSED);
        expect(text).not.toContain("orchestrator");
        expect(text).toContain("`files`");
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("asks nothing without declared files, and a subagent's write is refused with its own text", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subagent-nofiles-"));
    try {
      const { gate, prompts } = gateApproving();
      const writes: string[] = [];
      const { deps } = harness({
        approvals: gate,
        approvalRequired: true,
        workingDir: repo,
        runTurn: async (session) => {
          writes.push(await writeAs(gate, session.id, repo, join(repo, "a.ts")));
          return {
            session: createEmptySessionState({ id: "s-x", workingDir: repo }),
            reason: "reply",
            stepCount: 1,
          };
        },
      });
      await buildSubagentRunTool(deps).run(ONE_TASK, ctx({ workingDir: repo }));
      expect(prompts).toHaveLength(0);
      expect(writes).toEqual([SUBAGENT_APPROVAL_REFUSED]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not start a subagent when the person declines the declared files", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subagent-declined-"));
    try {
      const prompts: ApprovalRequest[] = [];
      const gate: ApprovalGate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          prompts.push(req);
          queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: false }));
        },
      });
      const { deps, calls } = harness({ approvals: gate, approvalRequired: true, workingDir: repo });
      const result = await buildSubagentRunTool(deps).run(
        { tasks: [{ id: "fix", instructions: "Fix a.ts.", files: ["a.ts"] }] },
        ctx({ workingDir: repo }),
      );
      expect(prompts).toHaveLength(1);
      expect(result.status).toBe("error");
      expect(result.details).toMatchObject({ reason: "writes-denied", deniedByUser: true });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("asks again in the next turn: a yes holds only for the turn it was given in", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subagent-turns-"));
    try {
      const { gate, prompts } = gateApproving();
      const { deps } = harness({ approvals: gate, approvalRequired: true, workingDir: repo });
      const tool = buildSubagentRunTool(deps);
      const call = { tasks: [{ id: "fix", instructions: "Fix a.ts.", files: ["a.ts"] }] };
      await tool.run(call, ctx({ workingDir: repo, turnId: "t1", stepIndex: 0 }));
      expect(prompts).toHaveLength(1);
      // Same turn: the standing yes covers it.
      await tool.run(call, ctx({ workingDir: repo, turnId: "t1", stepIndex: 2 }));
      expect(prompts).toHaveLength(1);
      // Next turn, same files: asked again, though nothing cleared the
      // gate's turn grant at turn start (only a Fusion turn does).
      await tool.run(call, ctx({ workingDir: repo, turnId: "t2", stepIndex: 0 }));
      expect(prompts).toHaveLength(2);
      // No turn id: never rides a standing yes.
      await tool.run(call, ctx({ workingDir: repo }));
      expect(prompts).toHaveLength(3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the operator-only refusal for steps no declared file can authorise", () => {
    expect(subagentRefusalFor({ category: "shell_dangerous" })).toBe(SUBAGENT_OPERATOR_ONLY_REFUSED);
    expect(subagentRefusalFor({ category: "fs_write_workspace" })).toBeUndefined();
    expect(SUBAGENT_OPERATOR_ONLY_REFUSED).not.toContain("orchestrator");
  });
});

describe("subagent.run under the turn's spend ceiling (ATO-1670)", () => {
  /** A turn's spend seam: a ceiling and a running total tools add to. */
  function spend(ceilingUsd: number, startUsd = 0) {
    let spent = startUsd;
    return {
      seam: {
        ceilingUsd,
        spentUsd: () => spent,
        add: (usd: number) => {
          if (Number.isFinite(usd) && usd > 0) spent += usd;
        },
      },
      spent: () => spent,
    };
  }

  /** $1 per million tokens either way: a completion of 1M prompt tokens costs $1. */
  const PRICE = { input: 1, output: 1 };
  const USAGE_1_USD = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };

  /** A child turn that bills $1, then ends cancelled if its signal was stopped. */
  const billingRunTurn =
    (calls: string[]): SubagentRunDeps["runTurn"] =>
    async (session, _message, options) => {
      calls.push(session.id);
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({
        type: "llm_event",
        event: { type: "llm_completed", completion: { usage: USAGE_1_USD } },
      } as unknown as AgentLoopEvent);
      const stopped = options.signal?.aborted === true;
      if (!stopped) {
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "done" },
        });
      }
      return {
        session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
        reason: stopped ? "cancelled" : "reply",
        stepCount: 1,
      };
    };

  const threeTasks = {
    tasks: [
      { id: "a", instructions: "Do a." },
      { id: "b", instructions: "Do b." },
      { id: "c", instructions: "Do c." },
    ],
  };

  type Row = { id: string; status: string; error?: string; notes?: string[] };
  const rowsOf = (details: unknown): Row[] => (details as { tasks: Row[] }).tasks;

  it("starts no subagent once the ceiling is reached: refused up front, as fusion.delegate refuses at its cap", async () => {
    const calls: string[] = [];
    const { deps } = harness({ runTurn: billingRunTurn(calls), resolveWorkerPricing: () => PRICE });
    const ledger = spend(1, 1);
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx({ turnSpend: ledger.seam }));
    expect(result.status).toBe("error");
    expect(calls).toHaveLength(0);
    expect(result.details).toMatchObject({ reason: "cost-ceiling", spentUsd: 1, ceilingUsd: 1 });
    expect(result.summary).toContain(
      "subagent.run did not run: the spend budget for this task is reached: $1.00 spent of the $1.00 allowed.",
    );
    expect(result.summary).toContain(SUBAGENT_CEILING_INSTRUCTION);
  });

  it("refuses at the ceiling before asking about declared files or counting toward the per-turn cap", async () => {
    const repo = mkdtempSync(join(tmpdir(), "subagent-ceiling-"));
    try {
      const prompts: ApprovalRequest[] = [];
      const gate: ApprovalGate = new ApprovalGate({
        level: 1,
        emit: (req) => {
          prompts.push(req);
          queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved: true }));
        },
      });
      const turnLedger = new SubagentTurnLedger();
      const calls: string[] = [];
      const { deps } = harness({
        approvals: gate,
        approvalRequired: true,
        workingDir: repo,
        turnLedger,
        runTurn: billingRunTurn(calls),
      });
      const result = await buildSubagentRunTool(deps).run(
        { tasks: [{ id: "fix", instructions: "Fix a.ts.", files: ["a.ts"] }] },
        ctx({ workingDir: repo, turnId: "t1", turnSpend: spend(1, 2).seam }),
      );
      expect(result.details).toMatchObject({ reason: "cost-ceiling" });
      expect(prompts).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(turnLedger.childrenThisTurn("s-operator", { turnId: "t1", stepIndex: 2 })).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("stops the running subagent and starts no more when the ceiling is reached mid-run", async () => {
    const calls: string[] = [];
    const { deps } = harness({
      runTurn: billingRunTurn(calls),
      resolveWorkerPricing: () => PRICE,
      // A local leg runs one at a time, so the order is fixed.
      workerSupportsSlotAffinity: () => true,
    });
    const ledger = spend(1.5);
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx({ turnSpend: ledger.seam }));
    // a bills $1 (under), b bills $1 (over: stopped), c never starts.
    expect(calls).toHaveLength(2);
    const [a, b, c] = rowsOf(result.details);
    expect(a!.status).toBe("ok");
    expect(b!.status).toBe("cancelled");
    expect(b!.notes?.some((n) => n.startsWith("stopped by the turn's cap: the spend budget for this task is reached"))).toBe(true);
    expect(c!.status).toBe("cancelled");
    expect(c!.error).toBe(
      "not started: the spend budget for this task is reached: $2.00 spent of the $1.50 allowed",
    );
    // The output closes with the stop line and what to do, as Fusion's does.
    expect(result.summary).toContain(
      `\n\nStopped: the spend budget for this task is reached: $2.00 spent of the $1.50 allowed. ${SUBAGENT_CEILING_INSTRUCTION}`,
    );
  });

  it("notes the ceiling on a cut row whatever status the runner gave it, and not on one that finished first", async () => {
    // A child that ends "failed" (not "cancelled") when its signal is cut.
    const calls: string[] = [];
    const failingWhenCut: SubagentRunDeps["runTurn"] = async (session, _message, options) => {
      calls.push(session.id);
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      options.eventHook?.({
        type: "llm_event",
        event: { type: "llm_completed", completion: { usage: USAGE_1_USD } },
      } as unknown as AgentLoopEvent);
      const cut = options.signal?.aborted === true;
      if (!cut) {
        options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "done" } });
      }
      return {
        session: {
          ...createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
          lastError: cut ? "connection closed" : null,
        },
        reason: cut ? "failed" : "reply",
        stepCount: 1,
      };
    };
    const { deps } = harness({
      runTurn: failingWhenCut,
      resolveWorkerPricing: () => PRICE,
      workerSupportsSlotAffinity: () => true,
    });
    const result = await buildSubagentRunTool(deps).run(
      threeTasks,
      ctx({ turnSpend: spend(1.5).seam }),
    );
    const [a, b, c] = rowsOf(result.details);
    expect(a!.status).toBe("ok");
    expect((a!.notes ?? []).some((n) => n.startsWith("stopped by the turn's cap"))).toBe(false);
    expect(b!.status).not.toBe("ok");
    expect(b!.status).not.toBe("cancelled");
    expect((b!.notes ?? []).some((n) => n.startsWith("stopped by the turn's cap: the spend budget"))).toBe(true);
    // A task that never started says so in its error, not in a note.
    expect(c!.error?.startsWith("not started:")).toBe(true);
    expect((c!.notes ?? []).some((n) => n.startsWith("stopped by the turn's cap"))).toBe(false);
  });

  it("adds each subagent's priced spend to the turn's spend", async () => {
    const calls: string[] = [];
    const { deps } = harness({ runTurn: billingRunTurn(calls), resolveWorkerPricing: () => PRICE });
    const ledger = spend(100, 0.5);
    const result = await buildSubagentRunTool(deps).run(
      { tasks: [{ id: "a", instructions: "Do a." }, { id: "b", instructions: "Do b." }] },
      ctx({ turnSpend: ledger.seam }),
    );
    expect(result.status).toBe("ok");
    expect(ledger.spent()).toBeCloseTo(2.5);
  });

  it("counts an unpriced local leg as $0, as Fusion does, and says nothing about it", async () => {
    const calls: string[] = [];
    const { deps } = harness({
      runTurn: billingRunTurn(calls),
      resolveWorkerPricing: () => undefined,
      workerSupportsSlotAffinity: () => true,
    });
    const ledger = spend(1);
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx({ turnSpend: ledger.seam }));
    expect(calls).toHaveLength(3);
    expect(ledger.spent()).toBe(0);
    for (const row of rowsOf(result.details)) {
      expect(row.notes ?? []).not.toContain(SUBAGENT_UNPRICED_NOTE);
    }
  });

  it("notes on each row of an unpriced cloud leg that the ceiling was not applied to it", async () => {
    const calls: string[] = [];
    const { deps } = harness({ runTurn: billingRunTurn(calls), resolveWorkerPricing: () => undefined });
    const ledger = spend(1);
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx({ turnSpend: ledger.seam }));
    expect(calls).toHaveLength(3);
    expect(ledger.spent()).toBe(0);
    for (const row of rowsOf(result.details)) {
      expect(row.notes).toContain(SUBAGENT_UNPRICED_NOTE);
    }
  });

  it("adds no unpriced note without a ceiling", async () => {
    const { deps } = harness({ resolveWorkerPricing: () => undefined });
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx());
    for (const row of rowsOf(result.details)) {
      expect(row.notes ?? []).not.toContain(SUBAGENT_UNPRICED_NOTE);
    }
  });

  it("changes nothing without a ceiling: every subagent runs and no row says it was stopped", async () => {
    const calls: string[] = [];
    const { deps } = harness({ runTurn: billingRunTurn(calls), resolveWorkerPricing: () => PRICE });
    const result = await buildSubagentRunTool(deps).run(threeTasks, ctx());
    expect(calls).toHaveLength(3);
    for (const row of rowsOf(result.details)) {
      expect(row.status).toBe("ok");
      expect(row.error).toBeUndefined();
      expect((row.notes ?? []).some((n) => n.includes("stopped by the turn's cap"))).toBe(false);
    }
    expect(result.details).not.toHaveProperty("stoppedBy");
  });
});
