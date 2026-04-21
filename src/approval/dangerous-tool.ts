import type { ApprovalGate } from "./approval-gate.js";

export interface DangerousToolOptions {
  approvals: ApprovalGate;
  /** When false, the gate is bypassed (used in tests and `--no-approval`). */
  approvalRequired: boolean;
}

export interface ApprovalPrompt {
  sessionId: string;
  tool: string;
  reason: string;
  preview?: string;
  affectedResources?: string[];
}

export class ApprovalDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason?: string,
  ) {
    super(`approval denied for ${tool}${reason ? `: ${reason}` : ""}`);
    this.name = "ApprovalDeniedError";
  }
}

/**
 * Shared helper used by dangerous tools (shell.run, fs.write,
 * skill.run_script, …). Centralising it ensures every tool sends the same
 * approval payload shape and honours the `approvalRequired` override in a
 * single place.
 */
export async function requireApproval(
  options: DangerousToolOptions,
  prompt: ApprovalPrompt,
  signal: AbortSignal,
): Promise<void> {
  if (!options.approvalRequired) return;
  const decision = await options.approvals.request(
    {
      sessionId: prompt.sessionId,
      tool: prompt.tool,
      reason: prompt.reason,
      ...(prompt.preview !== undefined ? { preview: prompt.preview } : {}),
      ...(prompt.affectedResources !== undefined
        ? { affectedResources: prompt.affectedResources }
        : {}),
    },
    { signal },
  );
  if (!decision.approved) {
    throw new ApprovalDeniedError(prompt.tool, decision.reason);
  }
}
