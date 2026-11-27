import { describe, expect, it } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  createFusionWorkerSession,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolContext } from "../tool-registry.js";
import { LOCAL_LEG_UNRESPONSIVE_ERROR } from "../fusion/local-leg-health.js";
import { buildSubagentRunTool, type SubagentRunDeps } from "./index.js";

/**
 * ATO-2430 / issue #490 for `subagent.run`. After a local worker was cut
 * off mid-generation, later local requests in the same process never
 * reached the server until the agent was restarted. `fusion.delegate`
 * answers that by asking the server before the next local worker is sent
 * and sending it on fresh connections (ATO-917, ATO-1357). Subagents run
 * on the same runner, but were never told their leg was local, so a
 * cut-off subagent left nothing marked and the next one went out on the
 * old connections with nobody asking.
 */

type TurnOptions = Parameters<SubagentRunDeps["runTurn"]>[2];

function mode(): ResolvedRunMode {
  return {
    effective: "local",
    workerMaxSteps: 6,
    // Tiny, so the first subagent's own clock cuts it within the test.
    workerTimeoutMs: 40,
    cloudWorkers: 4,
  } as unknown as ResolvedRunMode;
}

function result(reason: RunTurnResult["reason"]): RunTurnResult {
  return {
    session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
    reason,
    stepCount: reason === "reply" ? 1 : 0,
  };
}

/** Served one token, then generating until its clock cuts it. */
function servedThenHung(options: TurnOptions): Promise<RunTurnResult> {
  options.eventHook?.({
    type: "llm_event",
    event: { type: "assistant_delta", delta: "..." },
  } as never);
  return new Promise<RunTurnResult>((resolve) => {
    options.signal?.addEventListener("abort", () => resolve(result("cancelled")), {
      once: true,
    });
  });
}

function okTurn(options: TurnOptions): Promise<RunTurnResult> {
  options.eventHook?.({
    type: "llm_event",
    event: { type: "assistant_reply", text: "done" },
  } as never);
  return Promise.resolve(result("reply"));
}

function harness(over: Partial<SubagentRunDeps>): {
  deps: SubagentRunDeps;
  order: string[];
} {
  const order: string[] = [];
  let turns = 0;
  const deps: SubagentRunDeps = {
    // The first subagent hangs until it is cut; every later one answers.
    runTurn: (_session, _message, options) => {
      turns += 1;
      order.push(`turn${turns}`);
      return turns === 1 ? servedThenHung(options) : okTurn(options);
    },
    createEphemeralSession: (meta: FusionWorkerMeta, dir?: string) =>
      createFusionWorkerSession({ workingDir: dir ?? "/repo", meta }),
    approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
    emitEvent: () => {},
    workingDir: "/repo",
    resolveRunMode: () => mode(),
    resolveSessionLeg: () => ({ providerId: "local-llama", model: "gemma" }),
    workerSupportsSlotAffinity: () => true,
    approvalRequired: false,
    outputCharCap: 8_000,
    renewLocalTransport: () => {
      order.push("renew");
      return true;
    },
    probeLocalHealth: async () => {
      order.push("health");
      return "answered";
    },
    ...over,
  };
  return { deps, order };
}

function ctx(sessionId = "s-operator"): ToolContext {
  return {
    workingDir: "/repo",
    sessionId,
    stepIndex: 1,
    signal: new AbortController().signal,
  };
}

type Row = { id: string; status: string; error?: string };
const rowsOf = (details: unknown): Row[] => (details as { tasks: Row[] }).tasks;

const TWO_TASKS = {
  tasks: [
    { id: "a", instructions: "Do a." },
    { id: "b", instructions: "Do b." },
  ],
};

describe("subagent.run after a cut-off local subagent (ATO-2430, issue #490)", () => {
  it("asks the server and renews the connections before the next local subagent is sent", async () => {
    const { deps, order } = harness({});
    const out = await buildSubagentRunTool(deps).run(TWO_TASKS, ctx());
    const [a, b] = rowsOf(out.details);
    expect(a!.status).toBe("timeout");
    expect(b!.status).toBe("ok");
    // Nothing is asked before the first one (nothing was cut yet); the
    // second goes out only after the check and on a fresh pool.
    expect(order).toEqual(["turn1", "health", "renew", "turn2"]);
  });

  it("keeps the mark across calls: the next call's local subagent is checked too", async () => {
    const { deps, order } = harness({});
    const tool = buildSubagentRunTool(deps);
    await tool.run({ tasks: [{ id: "a", instructions: "Do a." }] }, ctx("s-one"));
    await tool.run({ tasks: [{ id: "b", instructions: "Do b." }] }, ctx("s-two"));
    expect(order).toEqual(["turn1", "health", "renew", "turn2"]);
  });

  it("fails the next local subagent at once when the server stopped answering", async () => {
    const { deps, order } = harness({
      probeLocalHealth: async () => {
        order.push("health");
        return "unanswered";
      },
    });
    const out = await buildSubagentRunTool(deps).run(TWO_TASKS, ctx());
    const [a, b] = rowsOf(out.details);
    expect(a!.status).toBe("timeout");
    expect(b!.status).toBe("failed");
    expect(b!.error).toBe(LOCAL_LEG_UNRESPONSIVE_ERROR);
    // Asked twice (LOCAL_LEG_HEALTH_ATTEMPTS), never sent, never renewed.
    expect(order).toEqual(["turn1", "health", "health"]);
  }, 10_000);

  it("leaves a cloud leg alone: no check and no renewal after a cut", async () => {
    const { deps, order } = harness({ workerSupportsSlotAffinity: () => false });
    // A cloud leg runs its subagents side by side; both start at once.
    const out = await buildSubagentRunTool(deps).run(TWO_TASKS, ctx());
    expect(rowsOf(out.details)).toHaveLength(2);
    expect(order.filter((step) => step === "health" || step === "renew")).toEqual([]);
  });
});
