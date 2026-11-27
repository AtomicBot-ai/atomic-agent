import { describe, expect, it } from "vitest";

import type { RunTurnResult } from "../../agent/agent-loop.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import {
  createFusionWorkerSession,
  type FusionWorkerMeta,
} from "../../session/fusion-worker-session.js";
import { createEmptySessionState } from "../../session/session-state.js";
import type { ToolContext } from "../tool-registry.js";
import { buildSubagentRunTool, type SubagentRunDeps } from "./index.js";

/**
 * ATO-2440: `atag run --disallowed-tools os.shell.run` hides the shell
 * from the chat's turn; a subagent that turn starts must not get it back.
 * The parent's `ToolContext.toolFilter` is ANDed into the worker's filter.
 */
describe("subagent.run under the parent turn's tool filter (ATO-2440)", () => {
  function harness(): {
    deps: SubagentRunDeps;
    filters: Array<((name: string) => boolean) | undefined>;
  } {
    const filters: Array<((name: string) => boolean) | undefined> = [];
    const deps: SubagentRunDeps = {
      runTurn: async (_session, _message, options) => {
        filters.push(options.toolFilter);
        options.eventHook?.({
          type: "llm_event",
          event: { type: "assistant_reply", text: "done" },
        });
        const result: RunTurnResult = {
          session: createEmptySessionState({ id: "s-x", workingDir: "/repo" }),
          reason: "reply",
          stepCount: 1,
        };
        return result;
      },
      createEphemeralSession: (meta: FusionWorkerMeta, dir?: string) =>
        createFusionWorkerSession({ workingDir: dir ?? "/repo", meta }),
      approvals: { setSessionPolicy: () => {}, clearSessionPolicy: () => {} },
      emitEvent: () => {},
      workingDir: "/repo",
      resolveRunMode: () =>
        ({
          effective: "local",
          workerMaxSteps: 6,
          workerTimeoutMs: 60_000,
          cloudWorkers: 4,
        }) as unknown as ResolvedRunMode,
      resolveSessionLeg: (pinned) => ({ providerId: pinned ?? "p", model: "m" }),
      workerSupportsSlotAffinity: () => false,
      approvalRequired: false,
      outputCharCap: 8_000,
    };
    return { deps, filters };
  }

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    workingDir: "/repo",
    sessionId: "s-operator",
    stepIndex: 1,
    signal: new AbortController().signal,
    ...over,
  });

  const ONE_TASK = { tasks: [{ id: "t", instructions: "Look around." }] };

  it("hides from the worker what the parent turn hides", async () => {
    const { deps, filters } = harness();
    const parent = (name: string): boolean => name !== "os.shell.run";
    const result = await buildSubagentRunTool(deps).run(ONE_TASK, ctx({ toolFilter: parent }));
    expect(result.status).toBe("ok");
    const worker = filters[0]!;
    expect(worker("os.shell.run")).toBe(false);
    expect(worker("os.fs.read")).toBe(true);
    // The worker's own exclusions still hold.
    expect(worker("subagent.run")).toBe(false);
  });

  it("keeps the worker's own filter when the parent has none", async () => {
    const { deps, filters } = harness();
    await buildSubagentRunTool(deps).run(ONE_TASK, ctx());
    expect(filters[0]!("os.shell.run")).toBe(true);
  });
});
