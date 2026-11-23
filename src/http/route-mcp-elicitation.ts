import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

interface AnswerBody {
  id?: unknown;
  action?: unknown;
  content?: unknown;
}

/**
 * `POST /api/mcp/elicitation/answer` — the person's answer to an MCP
 * server's question shown from `GET /api/events?elicitation=1`
 * (ATO-1492).
 *
 * Body: `{ id, action: "accept" | "decline" | "cancel", content? }`.
 * A plain "confirm?" question (no fields) is accepted with no content.
 * An accepted answer that does not fit the form is a `400` naming the
 * field (never its value) and the question stays open; `404` once it is
 * no longer open (answered elsewhere, or the server gave up); `501` when
 * this agent has no elicitation broker.
 *
 * Deliberately not part of `/api/approval/resolve`: approvals can be
 * answered by the approval ladder itself, a server's question only by
 * a person.
 */
export function createAnswerMcpElicitationHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const broker = ctx.elicitations;
    if (!broker) {
      sendError(res, 501, openaiError("MCP elicitation is not wired on this agent"));
      return;
    }
    let body: AnswerBody;
    try {
      body = await readJsonBody<AnswerBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      sendError(res, 400, openaiError("id is required"));
      return;
    }
    const result = broker.answer(body.id, {
      action: body.action,
      ...(body.content !== undefined ? { content: body.content } : {}),
    });
    if (result.ok) {
      sendJson(res, 200, { resolved: true, id: body.id, action: body.action });
      return;
    }
    switch (result.error) {
      case "not_pending":
        sendError(res, 404, openaiError(`elicitation not pending: ${body.id}`));
        return;
      case "bad_action":
        sendError(res, 400, openaiError("action must be one of accept|decline|cancel"));
        return;
      case "invalid_answer":
        sendError(res, 400, openaiError(`answer does not fit the form: ${result.reason ?? ""}`));
        return;
    }
  };
}

/** `GET /api/mcp/elicitation` — the open questions, oldest first. */
export function createListMcpElicitationsHandler(): HttpHandler {
  return (_req, res, ctx) => {
    sendJson(res, 200, { elicitations: ctx.elicitations?.pending() ?? [] });
  };
}
