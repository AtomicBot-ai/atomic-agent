import { planLastTurnRollback, type LastTurnRollbackOptions } from "../session/session-truncate.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Plain words for each refusal; `code` is what a client branches on. */
const REFUSAL_MESSAGES: Record<string, string> = {
  nothing_to_undo: "this chat has no question to take back",
  turn_in_progress: "this chat has a turn in progress; try again when it finishes",
  turn_has_tools: "the last turn ran tools, so it cannot be taken back; send the question again instead",
  turn_steered: "a message was added to the last turn while it ran, so it cannot be taken back",
  turn_compacted: "the last turn is already part of a compacted summary, so it cannot be taken back",
  turn_stopped: "the last turn was stopped, and a stop can cut a tool call short without a trace, so it cannot be taken back; send the question again instead",
  turn_unrecognized: "the last turn is not a single question and answer, so it cannot be taken back",
  turn_mismatch: "the chat's last question is not the one given (expectText, expectPriorQuestions), so nothing was taken back",
};

/**
 * `POST /api/sessions/{id}/rollback-last-turn` (ATO-1298): remove the
 * chat's last question and its answer so a client can ask it again
 * without the model reading the old answer. Body `{}` or
 * `{ expectText?, expectPriorQuestions? }`: the question the client means,
 * by its text and by how many questions come before it (steers not
 * counted). When the stored last question differs in either, `409
 * turn_mismatch` and nothing is removed.
 *
 * Only removes. The answer is `200 { id, text }` with the question's
 * text; the client sends it again through `/v1/chat/completions` like
 * any message, so a retry runs exactly the path a first try does.
 *
 * `404 session_not_found` for an unknown chat (an agent without this
 * route answers 404 with no code, which is how a client tells the two
 * apart). `409` with a `code` when the turn cannot be taken back:
 * `turn_in_progress`, `turn_has_tools`, `turn_steered`,
 * `turn_compacted`, `turn_stopped`, `nothing_to_undo`, `turn_unrecognized`,
 * `turn_mismatch` (see
 * `planLastTurnRollback`). A refusal leaves the chat as it was.
 */
export function createRollbackLastTurnHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const options: LastTurnRollbackOptions = {};
    try {
      const body = (await readJsonBody<unknown>(req)) as
        | { expectText?: unknown; expectPriorQuestions?: unknown }
        | null;
      const text = body?.expectText;
      if (text !== undefined && typeof text !== "string") {
        sendError(res, 400, openaiError("expectText must be a string", "invalid_request_error", "expectText"));
        return;
      }
      if (text !== undefined) options.expectText = text;
      const prior = body?.expectPriorQuestions;
      if (prior !== undefined && (typeof prior !== "number" || !Number.isInteger(prior) || prior < 0)) {
        sendError(res, 400, openaiError("expectPriorQuestions must be a non-negative integer", "invalid_request_error", "expectPriorQuestions"));
        return;
      }
      if (prior !== undefined) options.expectPriorQuestions = prior;
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    // This process's turn, or one another process on the same state dir runs (the store's live statuses).
    const plan = ctx.runtime.turnController.isBusy(id)
      ? ({ ok: false, code: "turn_in_progress" } as const)
      : planLastTurnRollback(session, options);
    if (!plan.ok) {
      sendError(res, 409, openaiError(REFUSAL_MESSAGES[plan.code] ?? plan.code, "invalid_request_error", null, plan.code));
      return;
    }
    // Stop a compaction the person started on this chat: it would summarise
    // the turn being removed. A background rolling summary needs no stop: it
    // reloads the session and checks its boundary before it saves.
    ctx.runtime.cancelSessionCompaction(id);
    ctx.runtime.sessionStore.save(plan.state);
    // A stopped turn keeps its resume marker; the turn it points at is gone.
    ctx.runtime.sessionStore.clearTurnProgress(id);
    sendJson(res, 200, { id, text: plan.text });
  };
}
