import { SIDE_QUESTION_MAX_INPUT_CHARS } from "../runtime/side-question.js";
import { openaiError } from "./openai-errors.js";
import {
  onClientGone,
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `POST /api/btw` — the TUI's `/btw <question>` for other clients
 * (ATO-1152): a quick side question beside the main task.
 *
 * Body: `{ question: string, session_id?: string }`. Reply: `{ text }`.
 *
 * `runtime.askSideQuestion` answers with a digest of `session_id`'s
 * conversation as read-only context (none for an unknown or absent id),
 * no tools, its own `btw:` fallback partition, an output bound and a
 * 90 s deadline. Nothing is written: no turn, no transcript row, no
 * memory, so the answer never reaches the chat's later turns. It may run
 * while a turn of that chat is running.
 *
 * `400` for a bad body, a blank question or one over the length limit,
 * `501` when the runtime offers no side question, `502` when the model
 * failed or answered nothing, `504` on the deadline. A client that
 * disconnects aborts the call.
 */
export function createSideQuestionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const invalid = sideQuestionBodyError(body);
    if (invalid !== null) {
      sendError(res, 400, openaiError(invalid.message, "invalid_request_error", invalid.param));
      return;
    }
    if (!ctx.runtime.askSideQuestion) {
      sendError(res, 501, openaiError("side questions are not available in this runtime"));
      return;
    }
    const controller = new AbortController();
    onClientGone(res, () => controller.abort());
    const sessionId = typeof body.session_id === "string" && body.session_id ? body.session_id : undefined;
    const result = await ctx.runtime.askSideQuestion((body.question as string).trim(), {
      ...(sessionId ? { sessionId } : {}),
      signal: controller.signal,
    });
    if (controller.signal.aborted || res.writableEnded) return;
    if (result.ok) {
      sendJson(res, 200, { text: result.text });
      return;
    }
    const status = result.reason === "timed out" ? 504 : 502;
    sendError(res, status, openaiError(result.reason, "server_error"));
  };
}

/** Why the body cannot be asked, or null. Exported for the tests. */
export function sideQuestionBodyError(
  body: Record<string, unknown>,
): { message: string; param: string } | null {
  const question = body.question;
  if (typeof question !== "string" || question.trim().length === 0) {
    return { message: "question must be a non-empty string", param: "question" };
  }
  if (question.trim().length > SIDE_QUESTION_MAX_INPUT_CHARS) {
    return {
      message: `question is too long for a side question (over ${SIDE_QUESTION_MAX_INPUT_CHARS} characters)`,
      param: "question",
    };
  }
  if (body.session_id !== undefined && body.session_id !== null && typeof body.session_id !== "string") {
    return { message: "session_id must be a string", param: "session_id" };
  }
  return null;
}
