import { listPreviousReplies, planRestorePreviousReply } from "../session/session-truncate.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Plain words for each refusal; `code` is what a client branches on. */
const REFUSAL_MESSAGES: Record<string, string> = {
  no_previous_reply: "this chat keeps no earlier answer to its last question",
  bad_index: "index is not one of the kept answers",
  turn_in_progress: "this chat has a turn in progress; try again when it finishes",
  turn_has_tools: "the newest answer used tools, so it cannot be swapped for an earlier one",
  turn_steered: "a message was added to the newest answer while it ran, so it cannot be swapped",
  turn_compacted: "the newest answer is already part of a compacted summary, so it cannot be swapped",
  turn_stopped: "the newest answer was stopped, and a stop can cut a tool call short without a trace, so it cannot be swapped",
  turn_unrecognized: "the newest answer is not a single question and answer, so it cannot be swapped",
};

/**
 * `GET /api/sessions/{id}/previous-replies` (ATO-864): the earlier
 * answers "Regenerate" kept for the chat's last question, oldest first.
 * `200 { id, question, questionStored, previous: [{ index, text,
 * reasoning?, at, replacedAt }] }`; `previous` is empty (and `question`
 * null) when none is kept or the chat has moved past that question.
 * `questionStored: false` means the question itself is not in the
 * transcript (the new try never reached it). `404 session_not_found`.
 */
export function createListPreviousRepliesHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    const listed = listPreviousReplies(session);
    sendJson(res, 200, {
      id,
      question: listed.question,
      questionStored: listed.questionStored,
      previous: listed.replies.map((entry, index) => ({
        index,
        text: entry.reply.text,
        ...(entry.reply.reasoning !== undefined ? { reasoning: entry.reply.reasoning } : {}),
        at: entry.reply.at,
        replacedAt: entry.replacedAt,
      })),
    });
  };
}

/**
 * `POST /api/sessions/{id}/restore-previous-reply` (ATO-864): put an
 * earlier answer to the chat's last question back in the transcript, in
 * place of the newest one (which is kept in turn when it is a real
 * answer), so going back after a failed or worse regenerate is one
 * call. Body `{}` (the newest kept answer) or `{ index }` from
 * `GET .../previous-replies`.
 *
 * `200 { id, text, previousReplies }`: the answer now in the chat and
 * how many earlier ones remain. `409` with a `code` when it cannot:
 * `no_previous_reply`, `turn_in_progress`, or the newest turn cannot be
 * taken back under the rollback rules (`turn_has_tools`, `turn_steered`,
 * `turn_stopped`, `turn_compacted`, `turn_unrecognized`). `400
 * bad_index`. A refusal leaves the chat as it was.
 */
export function createRestorePreviousReplyHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let index: number | undefined;
    try {
      const body = (await readJsonBody<unknown>(req)) as { index?: unknown } | null;
      const raw = body?.index;
      if (raw !== undefined && (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)) {
        sendError(res, 400, openaiError("index must be a non-negative integer", "invalid_request_error", "index", "bad_index"));
        return;
      }
      index = raw;
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    const plan = ctx.runtime.turnController.isBusy(id)
      ? ({ ok: false, code: "turn_in_progress" } as const)
      : planRestorePreviousReply(session, index);
    if (!plan.ok) {
      const status = plan.code === "bad_index" ? 400 : 409;
      sendError(res, status, openaiError(REFUSAL_MESSAGES[plan.code] ?? plan.code, "invalid_request_error", null, plan.code));
      return;
    }
    // As the rollback route: a compaction started on this chat would
    // summarise the turn being swapped out.
    ctx.runtime.cancelSessionCompaction(id);
    ctx.runtime.sessionStore.save(plan.state);
    ctx.runtime.sessionStore.clearTurnProgress(id);
    sendJson(res, 200, { id, text: plan.text, previousReplies: plan.previousReplies });
  };
}
