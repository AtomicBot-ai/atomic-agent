import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/sessions/{id}/resume` (ATO-448): continue the chat's last
 * turn when a restart cut it off, the HTTP side of the TUI's `/resume`.
 *
 * Never continues anything on its own: it answers the person's click.
 * `200 { id, text }` hands out the continuing message (a note that tools
 * may or may not have completed and side effects must be checked before
 * they are repeated, then the interrupted request) and marks the turn
 * "resume queued", so a second call answers `409 nothing_to_resume`. The
 * client sends `text` through `POST /v1/chat/completions` like any
 * message, the same path the TUI's `/resume` takes, so the reply streams
 * where every other reply does. The continuing turn replaces the old
 * progress marker when it starts.
 *
 * Body `{ "release": true }`: the client could not send that message
 * (the request failed, the person discarded it), so the turn is offered
 * again; `200 { id, released: true }`.
 *
 * `404 session_not_found` for an unknown chat (an agent without the route
 * answers 404 with no code). `409 turn_in_progress` while the chat runs
 * a turn, `409 nothing_to_resume` when its last turn was not cut off by a
 * restart, was already resumed, or this agent cannot resume turns.
 */
export function createResumeInterruptedTurnHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let release = false;
    try {
      const body = (await readJsonBody<unknown>(req)) as { release?: unknown } | null;
      if (body?.release !== undefined && typeof body.release !== "boolean") {
        sendError(res, 400, openaiError("release must be a boolean", "invalid_request_error", "release"));
        return;
      }
      release = body?.release === true;
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (!ctx.runtime.sessionStore.load(id)) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    const turns = ctx.runtime.interruptedTurns;
    if (release) {
      turns?.release(id);
      sendJson(res, 200, { id, released: true });
      return;
    }
    if (ctx.runtime.turnController.isBusy(id)) {
      sendError(res, 409, openaiError(
        "this chat has a turn in progress; try again when it finishes",
        "invalid_request_error", null, "turn_in_progress",
      ));
      return;
    }
    const text = turns?.resumeMessage(id) ?? null;
    if (text === null) {
      sendError(res, 409, openaiError(
        "nothing to resume: the last reply in this chat was not cut off by a restart",
        "invalid_request_error", null, "nothing_to_resume",
      ));
      return;
    }
    sendJson(res, 200, { id, text });
  };
}
