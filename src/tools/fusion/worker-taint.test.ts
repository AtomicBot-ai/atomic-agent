import { describe, expect, it } from "vitest";

import { ApprovalGate } from "../../approval/approval-gate.js";
import type { RunTurnResult } from "../../agent/agent-loop.js";
import { createEmptySessionState } from "../../session/session-state.js";
import { FUSION_WORKER_ID_PREFIX, type FusionWorkerMeta } from "../../session/fusion-worker-session.js";
import { runWorkerTasksCore, type WorkerRunnerCoreDeps } from "./worker-runner.js";
import { passWorkerTaintToParent } from "./worker-taint.js";

/* ATO-2481: outside text a worker read taints the parent's turn too. */

function harness(gate: ApprovalGate, readsOutside: boolean): WorkerRunnerCoreDeps {
  let minted = 0;
  return {
    runTurn: async (session, _message, options) => {
      options.eventHook?.({ type: "turn_started", turnIndex: 0 });
      // What the tool registry does when a worker's tool returns a web page.
      if (readsOutside) gate.noteUntrustedContent(session.id, "a web page");
      options.eventHook?.({ type: "llm_event", event: { type: "assistant_reply", text: "found it" } });
      const result: RunTurnResult = {
        session: createEmptySessionState({ id: session.id, workingDir: "/repo" }),
        reason: "reply",
        stepCount: 1,
      };
      return result;
    },
    createEphemeralSession: (meta: FusionWorkerMeta) => {
      minted += 1;
      return createEmptySessionState({
        id: `${FUSION_WORKER_ID_PREFIX}taint-${minted}`,
        workingDir: "/repo",
        metadata: { fusionWorker: { ...meta } },
      });
    },
    approvals: gate,
    emitEvent: () => {},
    workingDir: "/repo",
  };
}

function run(gate: ApprovalGate, readsOutside: boolean, origin: "subagent" | "fusion") {
  return runWorkerTasksCore(harness(gate, readsOutside), {
    parentSessionId: "s-parent",
    tasks: [{ id: "t0", title: "Look it up", instructions: "Read the page" }],
    maxWorkers: 1,
    providerId: "cloud-model",
    workerModel: "some-model",
    workerMaxSteps: 3,
    workerTimeoutMs: 60_000,
    signal: new AbortController().signal,
    origin,
  });
}

describe("worker taint reaches the parent (ATO-2481)", () => {
  it("marks the parent session when a subagent read outside content", async () => {
    const gate = new ApprovalGate({ emit: () => {} });
    const rows = await run(gate, true, "subagent");
    expect(rows[0]!.status).toBe("ok");
    expect(gate.outsideContentSources("s-parent")).toEqual(["a web page (via a subagent)"]);
  });

  it("names a Fusion worker when the run is Fusion's", async () => {
    const gate = new ApprovalGate({ emit: () => {} });
    await run(gate, true, "fusion");
    expect(gate.outsideContentSources("s-parent")).toEqual(["a web page (via a Fusion worker)"]);
  });

  it("leaves the parent clean when the worker read nothing from outside", async () => {
    const gate = new ApprovalGate({ emit: () => {} });
    await run(gate, false, "subagent");
    expect(gate.outsideContentSources("s-parent")).toEqual([]);
  });

  it("holds the parent's sensitive silent approvals once taint review is on", async () => {
    const gate = new ApprovalGate({ emit: () => {} });
    gate.setTaintReview(() => true);
    expect(gate.holdsForOutsideContent("s-parent", "http")).toBe(false);
    await run(gate, true, "subagent");
    expect(gate.holdsForOutsideContent("s-parent", "http")).toBe(true);
  });

  it("passWorkerTaintToParent does nothing on a gate without the taint methods", () => {
    expect(() => passWorkerTaintToParent({}, "w", "p", "subagent")).not.toThrow();
  });
});
