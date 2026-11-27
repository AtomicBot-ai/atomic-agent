import type { ApprovalGate, ApprovalRequest } from "../approval/approval-gate.js";

/**
 * `serve --refuse-approvals` (ATO-2172 review): the serve `atag launch`
 * starts for Claude Code, Codex or OpenCode. Those clients never read
 * `/api/events`, so a prompt there would wait forever and the client's
 * request with it. Every request that would prompt is refused at once
 * with this reason, which the agent turns into text; what the approval
 * level, a grant or a rule already allows still runs.
 */
export const LAUNCH_APPROVAL_REFUSAL =
  "refused: this atag serve was started by `atag launch` and nobody can answer an approval here. " +
  "Raise agent.approvalLevel, or start `atag serve` yourself and approve in its /panel page.";

/** The serve's approval handler under `--refuse-approvals`: deny at once. */
export function refuseApproval(approvals: ApprovalGate, request: ApprovalRequest): void {
  approvals.resolve({
    approvalId: request.approvalId,
    approved: false,
    reason: LAUNCH_APPROVAL_REFUSAL,
    automatic: true,
  });
}
