import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGate,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { describeAlwaysRule } from "../approval/approval-rules.js";
import type {
  ApprovalRequestPayload,
  ApprovalResponsePayload,
} from "./sidecar-events.js";

/**
 * The `approval_request` event for `request`: what the prompt shows,
 * plus which remembered answers the host may offer for it. A host that
 * draws only the buttons these allow never sends a grant the gate would
 * drop (ATO-1270).
 */
export function approvalRequestPayload(
  request: ApprovalRequest,
  gate: Pick<ApprovalGate, "canGrantAlways"> | undefined,
): ApprovalRequestPayload {
  const canAlways = gate?.canGrantAlways(request) ?? false;
  return {
    approvalId: request.approvalId,
    sessionId: request.sessionId,
    tool: request.tool,
    category: request.category,
    reason: request.reason,
    ...(request.preview !== undefined ? { preview: request.preview } : {}),
    ...(request.affectedResources !== undefined
      ? { affectedResources: [...request.affectedResources] }
      : {}),
    ...(request.commandShape !== undefined ? { commandShape: request.commandShape } : {}),
    ...(request.riskNote !== undefined ? { riskNote: request.riskNote } : {}),
    ...(request.riskLevel !== undefined ? { riskLevel: request.riskLevel } : {}),
    canSession: canGrantCategory(request),
    canShape: canGrantShape(request),
    canAlways,
    ...(canAlways ? { alwaysLabel: describeAlwaysRule(request) } : {}),
  };
}

/**
 * The grant an `approval_response` may carry for the request it answers,
 * checked against that request the way the HTTP route does: `session`
 * needs a grantable category, `shape` a shell request with a command
 * shape, `always` a rule the gate can save. Throws on a grant the
 * request cannot take, so the host hears about it and the request stays
 * pending rather than turning into a wider or narrower yes.
 */
export function responseGrant(
  payload: ApprovalResponsePayload,
  gate: Pick<ApprovalGate, "pendingRequest" | "canGrantAlways">,
): ApprovalGrantScope | undefined {
  const grant = payload.grant;
  if (grant === undefined || !payload.approved) return undefined;
  const request = gate.pendingRequest(payload.approvalId);
  if (request === null) return undefined;
  const allowed =
    grant === "session"
      ? canGrantCategory(request)
      : grant === "shape"
        ? canGrantShape(request)
        : grant === "always"
          ? gate.canGrantAlways(request)
          : false;
  if (!allowed) {
    throw new Error(
      `approval ${payload.approvalId} cannot take grant ${JSON.stringify(grant)}; it is still pending`,
    );
  }
  return grant === "session" ? "category" : grant;
}

/**
 * What the sidecar's `approval_response` handler does: resolve the
 * pending approval with the person's answer and, when they chose one,
 * the grant (`responseGrant` checks it first and throws on a grant the
 * request cannot take, leaving it pending). `false` when nothing was
 * waiting under that id.
 */
export function resolveApprovalResponse(
  payload: ApprovalResponsePayload,
  gate: Pick<ApprovalGate, "pendingRequest" | "canGrantAlways" | "resolve">,
): boolean {
  const grant = responseGrant(payload, gate);
  return gate.resolve({
    approvalId: payload.approvalId,
    approved: payload.approved,
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    ...(grant !== undefined ? { grant } : {}),
  });
}
