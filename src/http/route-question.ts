import { validateUserQuestionAnswer } from "../approval/user-question.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

interface AnswerBody {
  approvalId?: unknown;
  /** Option labels, or their 0-based indexes. */
  selected?: unknown;
  /** The person's own words ("Other"). */
  other?: unknown;
  /** True: the person closed the question without answering. */
  skip?: unknown;
}

/**
 * `POST /api/question/answer` — answer a question `ask_user` asked
 * (ATO-489). The question reaches the client as an ordinary
 * `approval_request` on `GET /api/events` with `category:
 * "user_question"` and a `question` object, replayed on reconnect like
 * any pending approval, so a reloaded window gets its open card back.
 *
 * Body: `{ approvalId, selected?: string[] | number[], other?: string }`,
 * or `{ approvalId, skip: true }` to skip. The answer is checked against
 * the gate's own pending question: an option it never offered, two picks
 * on a single-choice question or words where none are taken is a `400`
 * and the question stays open. `404` once it is no longer pending.
 */
export function createAnswerQuestionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: AnswerBody;
    try {
      body = await readJsonBody<AnswerBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const approvalId = body.approvalId;
    if (typeof approvalId !== "string" || approvalId.length === 0) {
      sendError(res, 400, openaiError("approvalId is required"));
      return;
    }
    const request = ctx.runtime.approvals.pendingRequest(approvalId);
    if (request === null) {
      ctx.approvalBus.resolved(approvalId);
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    const question = request.question;
    if (request.category !== "user_question" || question === undefined) {
      sendError(
        res,
        400,
        openaiError("not a question; answer it with POST /api/approval/resolve"),
      );
      return;
    }
    if (body.skip === true) {
      ctx.runtime.approvals.resolve({ approvalId, approved: false });
      ctx.approvalBus.resolved(approvalId);
      sendJson(res, 200, { resolved: true, approvalId, skipped: true });
      return;
    }
    const answer = validateUserQuestionAnswer(question, {
      selected: body.selected,
      other: body.other,
    });
    if (typeof answer === "string") {
      sendError(res, 400, openaiError(answer));
      return;
    }
    const resolved = ctx.runtime.approvals.resolve({ approvalId, approved: true, answer });
    ctx.approvalBus.resolved(approvalId);
    if (!resolved) {
      sendError(res, 404, openaiError(`approvalId not pending: ${approvalId}`));
      return;
    }
    sendJson(res, 200, { resolved: true, approvalId, answer });
  };
}
