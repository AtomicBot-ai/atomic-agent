import { RuntimeApiError } from "./runtime-api-error.js";

export interface ApprovalServiceDeps {
  approvals: {
    resolve(decision: {
      approvalId: string;
      approved: boolean;
      reason?: string;
    }): boolean;
  };
}

export interface ResolveApprovalInput {
  approvalId: string;
  approved: boolean;
  reason?: string;
}

/**
 * Resolve a pending approval. Throws `not_found` when the id is not
 * currently pending (already resolved, timed out, or never existed) so
 * both transports return the same "stale approval" signal.
 */
export function resolveApproval(
  deps: ApprovalServiceDeps,
  input: ResolveApprovalInput,
): { resolved: boolean; approvalId: string; approved: boolean } {
  if (typeof input.approvalId !== "string" || input.approvalId.length === 0) {
    throw new RuntimeApiError(
      "approvalId is required",
      "invalid_request",
      "approvalId",
    );
  }
  const resolved = deps.approvals.resolve({
    approvalId: input.approvalId,
    approved: input.approved,
    ...(input.reason ? { reason: input.reason } : {}),
  });
  if (!resolved) {
    throw new RuntimeApiError(
      `approvalId not pending: ${input.approvalId}`,
      "not_found",
    );
  }
  return { resolved: true, approvalId: input.approvalId, approved: input.approved };
}
