import { describe, expect, it } from "vitest";

import { ApprovalGate, type ApprovalRequest } from "../../approval/approval-gate.js";
import type { ApprovalLevel } from "../../approval/approval-level.js";
import type { DelegateTask } from "./delegate-args.js";
import { resolveFanoutScope } from "./fanout-paths.js";
import {
  askFanoutWrite,
  describeFanoutPreview,
  type FanoutWriteQuestion,
} from "./fanout-approval.js";
import * as fromDelegate from "./fusion-delegate.js";
import * as fromApproval from "./fanout-approval.js";

/**
 * The write question `fusion.delegate` and `subagent.run` share
 * (ATO-2446), against a real gate: which prompt it sends, what it
 * remembers for the turn, and what each caller's option changes.
 */

const SESSION = "s-parent";

function gateAt(
  level: ApprovalLevel,
  approve: (req: ApprovalRequest) => boolean = () => true,
): { gate: ApprovalGate; prompts: ApprovalRequest[] } {
  const prompts: ApprovalRequest[] = [];
  const gate: ApprovalGate = new ApprovalGate({
    level,
    emit: (req) => {
      prompts.push(req);
      const approved = approve(req);
      queueMicrotask(() => gate.resolve({ approvalId: req.approvalId, approved }));
    },
  });
  return { gate, prompts };
}

const tasks: DelegateTask[] = [
  { id: "a", title: "Write the parser", instructions: "Write it.", files: ["/repo/src/parser.ts"] },
];

function question(
  gate: ApprovalGate,
  over: Partial<FanoutWriteQuestion> = {},
): FanoutWriteQuestion {
  return {
    tool: "fusion.delegate",
    sessionId: SESSION,
    turnId: "t1",
    tasks,
    workingDir: "/repo",
    agentStateDir: "/home/u/.atomic-agent",
    approvals: gate,
    approvalRequired: true,
    signal: new AbortController().signal,
    reason: (scope, quiet) => `${quiet ? "quiet" : "asked"}: ${scope.join(", ")}`,
    ...over,
  };
}

describe("askFanoutWrite (ATO-2446)", () => {
  it("asks once under fusion_fanout with the task list and the scope", async () => {
    const { gate, prompts } = gateAt(1);
    const answer = await askFanoutWrite(question(gate));
    const scope = resolveFanoutScope(tasks, "/repo");
    expect(answer).toEqual({ ok: true, writeScope: scope, workersHoldScope: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      tool: "fusion.delegate",
      category: "fusion_fanout",
      reason: `asked: ${scope.join(", ")}`,
      preview: describeFanoutPreview(tasks, scope),
      affectedResources: scope,
    });
  });

  it("does not ask again in the same turn inside the approved directories", async () => {
    const { gate, prompts } = gateAt(1);
    await askFanoutWrite(question(gate));
    const second = await askFanoutWrite(question(gate));
    expect(second.ok).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it("asks again in a new turn", async () => {
    const { gate, prompts } = gateAt(1);
    await askFanoutWrite(question(gate));
    await askFanoutWrite(question(gate, { turnId: "t2" }));
    expect(prompts).toHaveLength(2);
  });

  it("refuses a scope in the agent's state directory before asking", async () => {
    const { gate, prompts } = gateAt(1);
    const answer = await askFanoutWrite(
      question(gate, {
        tasks: [
          {
            id: "a",
            title: "Edit config",
            instructions: "Edit it.",
            files: ["/home/u/.atomic-agent/plugins/x.json"],
          },
        ],
        workingDir: "/home/u/.atomic-agent",
      }),
    );
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.kind).toBe("agent-state-dir");
    expect(prompts).toHaveLength(0);
    expect(gate.fanoutScopes.turnGrantCovers(SESSION, ["/home/u/.atomic-agent"])).toBe(false);
  });

  it("returns the user's no as byUser, and grants nothing", async () => {
    const { gate } = gateAt(1, () => false);
    const answer = await askFanoutWrite(question(gate));
    expect(answer.ok).toBe(false);
    if (answer.ok || answer.kind !== "denied") throw new Error("expected a denial");
    expect(answer.byUser).toBe(true);
    expect(answer.message.length).toBeGreaterThan(0);
    expect(gate.fanoutScopes.turnGrantCovers(SESSION, ["/repo"])).toBe(false);
  });

  it("asks nothing when approvals are off, and still grants the scope", async () => {
    const { gate, prompts } = gateAt(1);
    const answer = await askFanoutWrite(question(gate, { approvalRequired: false }));
    expect(answer.ok).toBe(true);
    expect(prompts).toHaveLength(0);
  });

  it("clearStaleTurnState: without a turn id the standing answer is not read", async () => {
    const shared = gateAt(1);
    await askFanoutWrite(question(shared.gate, { turnId: undefined }));
    await askFanoutWrite(question(shared.gate, { turnId: undefined }));
    expect(shared.prompts).toHaveLength(1);

    const subagent = gateAt(1);
    const opts = { turnId: undefined, clearStaleTurnState: true, tool: "subagent.run" };
    await askFanoutWrite(question(subagent.gate, opts));
    await askFanoutWrite(question(subagent.gate, opts));
    expect(subagent.prompts).toHaveLength(2);
  });

  describe("the quiet branch (ATO-1689)", () => {
    it("goes through the gate as a workspace write and holds no scope", async () => {
      const { gate, prompts } = gateAt(2);
      const answer = await askFanoutWrite(question(gate, { allowQuiet: true }));
      expect(answer).toMatchObject({ ok: true, workersHoldScope: false });
      // Not the fan-out question: workspace writes are silent at level 2.
      expect(prompts.filter((p) => p.category === "fusion_fanout")).toHaveLength(0);
      // The level's yes is not remembered for the turn.
      expect(gate.fanoutScopes.turnGrantCovers(SESSION, ["/repo"])).toBe(false);
    });

    it("is off unless the caller allows it", async () => {
      const { gate, prompts } = gateAt(2);
      const answer = await askFanoutWrite(question(gate));
      expect(answer).toMatchObject({ ok: true, workersHoldScope: true });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.category).toBe("fusion_fanout");
    });

    it("asks after a worker was refused a command this turn", async () => {
      const { gate, prompts } = gateAt(2);
      gate.fanoutScopes.enterTurn(SESSION, "t1");
      gate.fanoutScopes.noteCommandRefused(SESSION);
      const answer = await askFanoutWrite(question(gate, { allowQuiet: true }));
      expect(answer).toMatchObject({ ok: true, workersHoldScope: true });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.category).toBe("fusion_fanout");
    });

    it("asks for a directory outside the chat's folder", async () => {
      const { gate, prompts } = gateAt(2);
      const answer = await askFanoutWrite(
        question(gate, {
          allowQuiet: true,
          tasks: [
            { id: "a", title: "Elsewhere", instructions: "Do it.", files: ["/other/x.ts"] },
          ],
        }),
      );
      expect(answer).toMatchObject({ ok: true, workersHoldScope: true });
      expect(prompts).toHaveLength(1);
    });
  });

  it("is what fusion-delegate.ts re-exports for the old imports", () => {
    expect(fromDelegate.scopeInsideStateDir).toBe(fromApproval.scopeInsideStateDir);
    expect(fromDelegate.describeFanoutPreview).toBe(fromApproval.describeFanoutPreview);
    expect(fromDelegate.fanoutQuietUnderLevel).toBe(fromApproval.fanoutQuietUnderLevel);
  });
});
