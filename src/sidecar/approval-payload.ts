import {
  canGrantCategory,
  canGrantShape,
  type ApprovalGate,
  type ApprovalGrantScope,
  type ApprovalRequest,
} from "../approval/approval-gate.js";
import { describeAlwaysRule } from "../approval/approval-rules.js";
import { siteGrantHost } from "../approval/site-grants.js";
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
  const canSession = canGrantCategory(request);
  const grantHost = canSession ? sessionGrantHost(request) : null;
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
    canSession,
    ...(grantHost !== null ? { grantHost } : {}),
    canShape: canGrantShape(request),
    canAlways,
    ...(canAlways ? { alwaysLabel: describeAlwaysRule(request) } : {}),
  };
}

/**
 * The one site a session grant for `request` covers, when it covers one
 * site rather than the whole category (ATO-1474): the host a browser
 * submit or off-site request names (`site-grants.ts`, ATO-1181), or the
 * origin an HTTP request is keyed by (`grantKey`, ATO-1182). `null` for
 * a whole-category grant.
 */
export function sessionGrantHost(request: ApprovalRequest): string | null {
  const host = siteGrantHost(request);
  if (host !== null) return host;
  return request.grantKey !== undefined ? request.grantKey : null;
}

/** Case, surrounding space and trailing dots or slashes aside. */
function normaliseGrantHost(value: string): string {
  return value.trim().toLowerCase().replace(/[./]+$/, "");
}

/**
 * Check the `grantHost` an `approval_response` names against the request
 * it answers. The gate always records the site from its own pending
 * request, so the field can never widen a grant; this check makes a
 * mismatch fail loudly instead of the host believing it granted a site
 * it did not. Absent is the pre-ATO-1474 behaviour: the session grant
 * takes the request's own scope, per site where the request has one.
 */
function checkGrantHost(
  payload: ApprovalResponsePayload,
  request: ApprovalRequest,
): void {
  const named: unknown = payload.grantHost;
  if (named === undefined) return;
  const fail = (why: string): never => {
    throw new Error(
      `approval ${payload.approvalId} cannot take grantHost ${JSON.stringify(named)}: ${why}; it is still pending`,
    );
  };
  if (typeof named !== "string" || named.trim().length === 0) fail("not a host");
  if (payload.grant !== "session") fail("only a session grant is per site");
  const own = sessionGrantHost(request);
  if (own === null) fail("this request's session grant is not per site");
  if (normaliseGrantHost(named as string) !== normaliseGrantHost(own as string)) {
    fail(`the request is for ${JSON.stringify(own)}`);
  }
}

/**
 * The grant an `approval_response` may carry for the request it answers,
 * checked against that request the way the HTTP route does: `session`
 * needs a grantable category, `shape` a shell request with a command
 * shape, `always` a rule the gate can save, and a `grantHost` must be
 * the request's own site (`checkGrantHost`). Throws on a grant the
 * request cannot take, so the host hears about it and the request stays
 * pending rather than turning into a wider or narrower yes.
 */
export function responseGrant(
  payload: ApprovalResponsePayload,
  gate: Pick<ApprovalGate, "pendingRequest" | "canGrantAlways">,
): ApprovalGrantScope | undefined {
  const grant = payload.grant;
  if (!payload.approved) return undefined;
  if (grant === undefined && payload.grantHost === undefined) return undefined;
  const request = gate.pendingRequest(payload.approvalId);
  if (request === null) return undefined;
  checkGrantHost(payload, request);
  if (grant === undefined) return undefined;
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
