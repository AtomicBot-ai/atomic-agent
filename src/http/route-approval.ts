import { resolveApproval } from "../runtime-api/index.js";

import { openaiError } from "./openai-errors.js";
import {
  beginSse,
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { sendRuntimeApiError } from "./runtime-api-http.js";

interface ResolveBody {
  approvalId?: string;
  decision?: string;
  reason?: string;
}

/**
 * `POST /api/approval/resolve` — resolve a pending approval emitted
 * by a dangerous tool. Accepts the hermes-style `allow-once` / `deny`
 * vocabulary plus the shorter `approve` / `reject` aliases. The
 * agent-side `allow-always` mode is intentionally deferred until
 * atomic-agent grows a per-tool trust store.
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
    const approved = parseDecision(rawDecision);
    if (approved === null) {
      sendError(
        res,
        400,
        openaiError(
          "decision must be one of allow-once|deny|approve|reject",
        ),
      );
      return;
    }
    try {
      resolveApproval(ctx.runtime, {
        approvalId,
        approved,
        ...(body.reason ? { reason: body.reason } : {}),
      });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
    ctx.approvalBus.resolved(approvalId);
    sendJson(res, 200, { resolved: true, approvalId, approved });
  };
}

function parseDecision(raw: unknown): boolean | null {
  if (typeof raw !== "string") return null;
  const normalised = raw.trim().toLowerCase();
  if (normalised === "allow-once" || normalised === "approve") return true;
  if (normalised === "deny" || normalised === "reject") return false;
  return null;
}

/**
 * `GET /api/events` — SSE stream of approval requests. Replays
 * already-pending requests on connect so late subscribers never miss
 * a prompt, then keeps the connection open for fresh emissions.
 */
export function createApprovalEventsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const sse = beginSse(res);
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
