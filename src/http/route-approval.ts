import { canGrantShape } from "../approval/approval-gate.js";

import { openaiError } from "./openai-errors.js";
import {
  beginSse,
  readJsonBody,
  sendError,
  sendJson,
  SSE_HEARTBEAT_MS,
  type HttpHandler,
} from "./request-context.js";

interface ResolveBody {
  approvalId?: string;
  decision?: string;
  /** On a deny, the user's own words; the model reads it as what they said. */
  reason?: string;
}

/**
 * The decisions `POST /api/approval/resolve` accepts, advertised on
 * `GET /api/capabilities` (`agent.approvalDecisions`) so a client draws
 * only the answers this agent understands. `approve` / `reject` are
 * accepted aliases of `allow-once` / `deny` and are not listed.
 */
export const APPROVAL_DECISIONS = [
  "allow-once",
  "allow-in-chat",
  "deny",
] as const;

type ParsedDecision = { approved: boolean; inChat: boolean };

/**
 * `POST /api/approval/resolve` — resolve a pending approval emitted
 * by a dangerous tool. Accepts the hermes-style `allow-once` / `deny`
 * vocabulary plus the shorter `approve` / `reject` aliases, and
 * `allow-in-chat`: approve, and stop asking about this command for the
 * rest of the chat. That is the gate's shape grant (the TUI's `[a]`),
 * scoped to the request's own session and its `commandShape` (the
 * binary, `git`), never to the whole category. A request without a
 * shape (not a shell call, or an opaque `bash -c …` the shell tool
 * withholds it for) cannot take it: the route answers 400 and the
 * request stays pending, so a click never turns into a wider or a
 * narrower yes than the one the person chose. A grant that outlives the
 * chat is deferred until atomic-agent grows a per-tool trust store.
 */
export function createResolveApprovalHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: ResolveBody;
    try {
      body = await readJsonBody<ResolveBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const approvalId = body.approvalId;
    const rawDecision = body.decision;
    if (!approvalId || typeof approvalId !== "string") {
      sendError(res, 400, openaiError("approvalId is required"));
      return;
    }
    const parsed = parseDecision(rawDecision);
    if (parsed === null) {
      sendError(
        res,
        400,
        openaiError(
          "decision must be one of allow-once|allow-in-chat|deny|approve|reject",
        ),
      );
      return;
    }
    const { approved, inChat } = parsed;
    if (inChat) {
      const request = ctx.runtime.approvals.pendingRequest(approvalId);
      if (request !== null && !canGrantShape(request)) {
        sendError(
          res,
          400,
          openaiError(
            "allow-in-chat needs a shell command the agent can name; answer allow-once or deny",
          ),
        );
        return;
      }
    }
    const resolved = ctx.runtime.approvals.resolve({
      approvalId,
      approved,
      ...(inChat ? { grant: "shape" as const } : {}),
      ...(body.reason ? { reason: body.reason } : {}),
    });
    if (!resolved) {
      // Not pending at the gate (its turn was aborted): not pending here either.
      ctx.approvalBus.resolved(approvalId);
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    ctx.approvalBus.resolved(approvalId);
    sendJson(res, 200, {
      resolved: true,
      approvalId,
      approved,
      ...(inChat ? { grant: "chat" } : {}),
    });
  };
}

function parseDecision(raw: unknown): ParsedDecision | null {
  if (typeof raw !== "string") return null;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "allow-once" || normalised === "approve")
    return { approved: true, inChat: false };
  if (normalised === "allow-in-chat") return { approved: true, inChat: true };
  if (normalised === "deny" || normalised === "reject")
    return { approved: false, inChat: false };
  return null;
}

/**
 * `GET /api/events` — SSE stream of approval requests. Replays
 * already-pending requests on connect so late subscribers never miss
 * a prompt, then keeps the connection open for fresh emissions.
 *
 * Only requests the gate still holds are replayed: one whose turn was
 * aborted is gone from the gate but was still in the bus. The stream
 * also carries a comment line now and then, so a client's idle timeout
 * (undici: 300 s) does not drop it and replay on every reconnect.
 */
export function createApprovalEventsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const sse = beginSse(res, {}, { heartbeatMs: SSE_HEARTBEAT_MS });
    ctx.approvalBus.prune((request) =>
      ctx.runtime.approvals.isPending(request.approvalId),
    );
    for (const pending of ctx.approvalBus.snapshot()) {
      sse.writeEvent("approval_request", pending);
    }
    const unsubscribe = ctx.approvalBus.subscribe((request) => {
      sse.writeEvent("approval_request", request);
    });
    await new Promise<void>((resolvePromise) => {
      req.on("close", () => {
        unsubscribe();
        sse.close();
        resolvePromise();
      });
    });
  };
}
