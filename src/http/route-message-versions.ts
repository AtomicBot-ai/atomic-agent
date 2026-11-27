import { listMessageVersions, planSwitchVersion, type SwitchVersionRefusal } from "../session/session-message-versions.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/** Plain words for each refusal; `code` is what a client branches on. */
const REFUSAL_MESSAGES: Record<SwitchVersionRefusal, string> = {
  no_version: "that is not a version of the question at that position",
  point_mismatch: "the chat's question at that position is not the one given (priorQuestions, expectText), so nothing was changed",
  point_compacted: "that message is inside the part of the chat already compacted into a summary",
  turn_in_progress: "this chat has a turn in progress; try again when it finishes",
  turn_has_tools: "the newest answer used tools, so it cannot be swapped for an earlier one",
  turn_steered: "a message was added to the newest answer while it ran, so it cannot be swapped",
  turn_compacted: "the newest answer is already part of a compacted summary, so it cannot be swapped",
  turn_stopped: "the newest answer was stopped, and a stop can cut a tool call short without a trace, so it cannot be swapped",
  turn_unrecognized: "the newest answer is not a single question and answer, so it cannot be swapped",
};

function notFound(id: string) {
  return openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found");
}

/**
 * `GET /api/sessions/{id}/message-versions` (ATO-2470): every question of
 * the chat that has another version, oldest first. A version is a branch
 * an edit kept (the message as it was and the conversation after it) or
 * an answer Regenerate kept. `200 { id, questions: [{ priorQuestions,
 * live: { text, at, answerAt } | null, versions: [{ ref, text, at,
 * answerAt, keptAt }], compacted }] }`; `live` is null when the question
 * is not in the transcript (a regenerate whose new try never reached the
 * store). `404 session_not_found`.
 */
export function createListMessageVersionsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, notFound(id));
      return;
    }
    sendJson(res, 200, { id, questions: listMessageVersions(session) });
  };
}

/**
 * `POST /api/sessions/{id}/switch-version` (ATO-2470): put one version of
 * a question in the chat. Body `{ priorQuestions, expectText?, ref }`, the
 * question by its position and text and the version by its `ref` from the
 * listing. The conversation from that question on is kept as a version
 * first, so nothing is lost by switching. Only the rows from that question
 * on change; the model then reads the chosen version as if it were the
 * only one.
 *
 * `200 { id, text, versions }`: the question now in the chat and how many
 * other versions it has. `409` with a `code` when it cannot (see
 * {@link REFUSAL_MESSAGES}), `400` for a bad body, `404 session_not_found`.
 * A refusal leaves the chat as it was.
 */
export function createSwitchVersionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let body: { priorQuestions?: unknown; expectText?: unknown; ref?: unknown } | null;
    try {
      body = (await readJsonBody<unknown>(req)) as typeof body;
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const prior = body?.priorQuestions;
    if (typeof prior !== "number" || !Number.isInteger(prior) || prior < 0) {
      sendError(res, 400, openaiError("priorQuestions must be a non-negative integer", "invalid_request_error", "priorQuestions"));
      return;
    }
    const expectText = body?.expectText;
    if (expectText !== undefined && typeof expectText !== "string") {
      sendError(res, 400, openaiError("expectText must be a string", "invalid_request_error", "expectText"));
      return;
    }
    const ref = body?.ref;
    if (typeof ref !== "string" || !/^[br]\d+$/.test(ref)) {
      sendError(res, 400, openaiError("ref must be a version ref from the listing", "invalid_request_error", "ref", "bad_ref"));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, notFound(id));
      return;
    }
    const plan = ctx.runtime.turnController.isBusy(id)
      ? ({ ok: false, code: "turn_in_progress" } as const)
      : planSwitchVersion(session, { priorQuestions: prior, ref, ...(expectText !== undefined ? { expectText } : {}) });
    if (!plan.ok) {
      sendError(res, 409, openaiError(REFUSAL_MESSAGES[plan.code], "invalid_request_error", null, plan.code));
      return;
    }
    // As the rollback and rewind routes: a compaction started on this chat
    // would summarise the rows being switched out.
    ctx.runtime.cancelSessionCompaction(id);
    ctx.runtime.sessionStore.save(plan.state);
    ctx.runtime.sessionStore.clearTurnProgress(id);
    sendJson(res, 200, { id, text: plan.text, versions: plan.versions });
  };
}
