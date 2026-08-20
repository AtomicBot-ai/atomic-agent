import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `GET /api/sessions` — list recent sessions in the current working
 * directory. `limit` (query string) caps the number of rows, default
 * 25, max 200. Payload mirrors `SessionState` minus the heavy
 * transcript by default — callers fetch the full state via
 * `/api/sessions/{id}` when they need it.
 */
export function createListSessionsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    let limit = 25;
    if (rawLimit !== null) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, 200);
    }
    const workingDir = ctx.runtime.capabilities.workingDir;
    const sessions = ctx.runtime.sessionStore.listByWorkingDir(
      workingDir,
      limit,
    );
    sendJson(res, 200, {
      sessions: sessions.map((s) => ({
        id: s.id,
        workingDir: s.workingDir,
        status: s.status,
        turnCount: s.turnCount,
        stepCount: s.stepCount,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastError: s.lastError,
      })),
    });
  };
}

/**
 * `GET /api/sessions/{id}` — return the full `SessionState`, including
 * the transcript. 404 if the session is not persisted.
 */
export function createGetSessionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const state = ctx.runtime.sessionStore.load(id);
    if (!state) {
      sendError(res, 404, openaiError(`session not found: ${id}`));
      return;
    }
    sendJson(res, 200, state);
  };
}

/**
 * `POST /api/sessions/{id}/steer` — fold `{ text }` into the turn
 * already running on that session.
 *
 * This is NOT a way to send a message: it never starts a turn and never
 * queues behind one (see §"Mid-turn steering" in AGENTS.md). When the
 * session is idle there is nothing to steer, and the caller is told so
 * with `409` rather than having the message silently disappear — the
 * correct follow-up is `POST /v1/chat/completions`. `429` means the
 * per-session steering inbox is full; the turn has not read any of them
 * yet, so piling on more would only bloat one prompt.
 *
 * `200 {steered:true}` means accepted, **not** delivered: the loop
 * drains the inbox at step boundaries, and a turn can end before the
 * next one. Anything left over is parked, not dropped — the turn hands
 * it back on `RunTurnResult.undelivered` and the route that ran the
 * turn puts it in the undelivered store, where
 * `GET /api/sessions/{id}/steer` finds it. That is the HTTP half of the
 * same promise the sidecar keeps with its `steer_undelivered` event.
 */
export function createSteerSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      sendError(
        res,
        400,
        openaiError(err instanceof Error ? err.message : "invalid body"),
      );
      return;
    }
    const text = body.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      sendError(res, 400, openaiError("text must be a non-empty string"));
      return;
    }
    if (!ctx.runtime.turnController.isBusy(id)) {
      sendError(
        res,
        409,
        openaiError(
          `session ${id} has no turn in flight — send the message with POST /v1/chat/completions instead`,
        ),
      );
      return;
    }
    if (!ctx.runtime.steer(id, text)) {
      sendError(
        res,
        429,
        openaiError(
          `steering inbox for session ${id} is full — the running turn has not consumed the pending messages yet`,
        ),
      );
      return;
    }
    sendJson(res, 200, { steered: true, sessionId: id });
  };
}

/**
 * `GET /api/sessions/{id}/steer` — the messages this session's turns
 * accepted for steering but never delivered.
 *
 * A steer that arrives during the final inference, or into a turn that
 * is cancelled before its next step, is handed back when the turn ends;
 * by then the `POST` that accepted it has long since answered, so the
 * server parks it here. Polling this endpoint is how a host that only
 * ever spoke to `POST .../steer` detects the loss; re-sending is a
 * normal `POST /v1/chat/completions`.
 *
 * Reads do not consume. A retried or prefetched `GET` must not be able
 * to lose a message — that is the bug this whole path exists to
 * prevent. Acknowledge with `DELETE /api/sessions/{id}/steer?through=`
 * once the text is safely somewhere else.
 *
 * `discarded` counts messages this session lost to the per-session cap
 * (`MAX_PARKED_STEERS`) because nobody acked in time. Non-zero means
 * text is genuinely gone, and the host is told rather than left to
 * assume the list is complete. It has its own ack
 * (`DELETE ...?discarded={n}`): acking the listed entries leaves it
 * standing, so a host that acks first and reads later still sees the
 * loss.
 */
export function createGetUndeliveredSteersHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const undelivered = ctx.undeliveredSteers.list(id);
    sendJson(res, 200, {
      sessionId: id,
      undelivered: undelivered.map((entry) => ({
        seq: entry.seq,
        text: entry.text,
        parkedAt: entry.parkedAt,
      })),
      discarded: ctx.undeliveredSteers.discarded(id),
    });
  };
}

/**
 * `DELETE /api/sessions/{id}/steer?through={seq}&discarded={n}` —
 * acknowledge what a prior `GET` reported. Both parameters are
 * optional individually; at least one must be present.
 *
 * `through` acks parked steers up to and including `seq`. The cursor is
 * mandatory rather than a bare "clear it" because a bare clear would
 * also drop whatever was parked between the caller's `GET` and this
 * call, which is a message the host never saw. Anything parked since
 * carries a higher `seq` and survives.
 *
 * `discarded` acks up to `n` of the messages the per-session cap threw
 * away. It is a **separate** ack, and for the same reason the cursor
 * exists: those messages have no `seq` the host was ever shown, so the
 * entry cursor cannot stand in for having read the loss count. Acking
 * the entries alone leaves `discarded` reporting the loss on the next
 * `GET` instead of quietly resetting it to zero. Counting rather than
 * clearing keeps discards that happened since the host's `GET`
 * outstanding.
 *
 * Idempotent — re-acking an already-acked cursor or count reports `0`.
 * The response repeats the loss still outstanding as `discarded`, so a
 * host that only ever calls `DELETE` still learns about it.
 */
export function createAckUndeliveredSteersHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const rawThrough = url.searchParams.get("through");
    const rawDiscarded = url.searchParams.get("discarded");
    if (rawThrough === null && rawDiscarded === null) {
      sendError(
        res,
        400,
        openaiError(
          "through and/or discarded is required — use the highest seq and the discarded count returned by GET /api/sessions/{id}/steer",
        ),
      );
      return;
    }
    const through = parseCount(rawThrough);
    if (through === null) {
      sendError(
        res,
        400,
        openaiError(
          "through must be a non-negative integer — use the highest seq returned by GET /api/sessions/{id}/steer",
        ),
      );
      return;
    }
    const discarded = parseCount(rawDiscarded);
    if (discarded === null) {
      sendError(
        res,
        400,
        openaiError(
          "discarded must be a non-negative integer — use the discarded count returned by GET /api/sessions/{id}/steer",
        ),
      );
      return;
    }
    const acked =
      through === undefined ? 0 : ctx.undeliveredSteers.ack(id, through);
    const discardsAcked =
      discarded === undefined
        ? 0
        : ctx.undeliveredSteers.ackDiscarded(id, discarded);
    sendJson(res, 200, {
      sessionId: id,
      acked,
      remaining: ctx.undeliveredSteers.list(id).length,
      discardsAcked,
      discarded: ctx.undeliveredSteers.discarded(id),
    });
  };
}

/**
 * `undefined` when the parameter was absent, `null` when it was present
 * but not a non-negative integer (the caller turns that into a 400).
 */
function parseCount(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * `DELETE /api/sessions/{id}` — purge the session row. Idempotent:
 * returns 200 whether or not the row existed so orchestrators can
 * blindly retry.
 */
export function createDeleteSessionHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    ctx.runtime.sessionStore.delete(id);
    // Purging the session takes its parked steers with it: they are
    // messages for a conversation the caller just said it is done with,
    // and leaving them would strand rows nobody will ever ack.
    ctx.undeliveredSteers.clear(id);
    sendJson(res, 200, { deleted: true, id });
  };
}
