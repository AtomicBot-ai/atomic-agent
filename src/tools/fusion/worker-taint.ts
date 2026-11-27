import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { TurnOrigin } from "../../runtime/turn-controller.js";

/**
 * ATO-2481: a worker (a `subagent.run` child or a Fusion worker) runs on
 * its own session, so the outside text it reads (a web page, an MCP
 * answer, GitHub issue titles) taints only that session
 * (`approval/untrusted-taint.ts`). Its findings then come back into the
 * parent's turn as the delegate tool's result, and that text may carry the
 * same instructions. So once a worker session is done, every source it read
 * is marked on the parent session too, with a label naming the worker, and
 * the parent's risky silent approvals are held for the rest of its turn
 * like after reading the page itself. A nested child passes it up one level
 * at a time, each runner to its own parent.
 */
export function passWorkerTaintToParent(
  approvals: Partial<Pick<ApprovalGate, "outsideContentSources" | "noteUntrustedContent">>,
  workerSessionId: string,
  parentSessionId: string,
  origin: TurnOrigin | undefined,
): void {
  const sources = approvals.outsideContentSources?.(workerSessionId) ?? [];
  if (sources.length === 0) return;
  const who = origin === "subagent" ? "a subagent" : "a Fusion worker";
  for (const source of sources) {
    approvals.noteUntrustedContent?.(parentSessionId, `${source} (via ${who})`);
  }
}
