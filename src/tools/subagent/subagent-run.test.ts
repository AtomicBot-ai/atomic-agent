import { describe, expect, it } from "vitest";

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
    turnLedger.record("s-operator", 1, SUBAGENT_MAX_CHILDREN_PER_TURN - 2);
    const { deps, calls } = harness({ turnLedger });
    const tool = buildSubagentRunTool(deps);

    const over = await tool.run({ tasks: tasks(3) }, ctx({ stepIndex: 2 }));
    expect(over.status).toBe("error");
    expect(over.details).toMatchObject({
      reason: "children-per-turn",
      already: SUBAGENT_MAX_CHILDREN_PER_TURN - 2,
      maxChildrenPerTurn: SUBAGENT_MAX_CHILDREN_PER_TURN,
    });
    expect(calls).toHaveLength(0);

    // Two still fit this turn.
    const fits = await tool.run({ tasks: tasks(2) }, ctx({ stepIndex: 3 }));
    expect(fits.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(turnLedger.childrenThisTurn("s-operator", 4)).toBe(
      SUBAGENT_MAX_CHILDREN_PER_TURN,
    );

    // A step index back at the start is the next turn: the count restarts.
    const nextTurn = await tool.run({ tasks: tasks(3, "n") }, ctx({ stepIndex: 0 }));
    expect(nextTurn.status).toBe("ok");
    expect(calls).toHaveLength(5);
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
