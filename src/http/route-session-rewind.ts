import type { ServerResponse } from "node:http";

import {
  applySessionRewind,
  previewSessionRewind,
  sessionRewindDeps,
} from "../runtime/session-rewind-service.js";
import { planFork, questionRowIndex, type ForkRefusal } from "../session/session-fork.js";
import { listRewindPoints, planRewind, type RewindRefusal } from "../session/session-rewind.js";
import type { SessionState } from "../session/session-state.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

/**
 * Taking a chat back to one of its questions with its files, and forking
 * it from one (ATO-1056, ATO-1058):
 *
 *  - `GET  /api/sessions/{id}/rewind-points` — the questions it can go back to.
 *  - `POST /api/sessions/{id}/rewind/preview` — what a rollback would do.
 *  - `POST /api/sessions/{id}/rewind` — do it: files first, then the chat
 *    (`files: false` the chat only, `conversation: false` the files only).
 *  - `POST /api/sessions/{id}/fork` — a new chat with the history through that question's answer.
 *
 * A question is named the way `rollback-last-turn` names one: `priorQuestions`
 * (how many questions come before it, steers not counted) and `expectText`.
 * A different stored question refuses (`409 point_mismatch`) and changes
 * nothing. Editing a sent message is a rollback to it followed by a normal
 * send of the new text; it needs no route of its own.
 *
 * Only changes made by the agent's own file tools are put back
 * (`fs-checkpoint-store.ts`); the preview lists the shell commands, git
 * commands, archive extractions and Fusion runs whose changes stay. The
 * rewind itself is `runtime/session-rewind-service.ts`, shared with the
 * terminal's `/rewind` (ATO-2467); this file only reads and answers HTTP.
 */

const REFUSAL_MESSAGES: Record<RewindRefusal | ForkRefusal, string> = {
  nothing_to_rewind: "this chat has no question to go back to",
  turn_in_progress: "this chat has a turn in progress; try again when it finishes",
  point_compacted: "that message is inside the part of the chat already compacted into a summary",
  point_mismatch: "the chat's question at that position is not the one given (priorQuestions, expectText), so nothing was changed",
};

interface Point {
  session: SessionState;
  turnIndex: number;
  /** Questions before it, steers not counted (what the body said). */
  priorQuestions: number;
  text: string;
  at: number;
  body: { files?: unknown; conversation?: unknown };
}

export function createListRewindPointsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) return notFound(res, id);
    sendJson(res, 200, {
      id,
      points: listRewindPoints(session).map((point) => ({
        turnIndex: point.turnIndex,
        priorQuestions: point.ordinal - 1,
        text: point.text,
        at: point.at,
      })),
    });
  };
}

/** `preview: true` answers what a rollback would do; `false` does it. */
export function createRewindHandler(preview: boolean): HttpHandler {
  return async (req, res, ctx) => {
    const point = await readPoint(req, res, ctx);
    if (point === null) return;
    const { session, turnIndex } = point;
    const deps = sessionRewindDeps(ctx.runtime);
    if (preview) {
      const planned = await previewSessionRewind(deps, session, turnIndex);
      if (!planned.ok) return refuse(res, planned.code);
      sendJson(res, 200, {
        id: session.id,
        ...planned.value,
        // This agent takes `conversation: false` (ATO-2112); an older one would cut the chat.
        filesOnly: true,
      });
      return;
    }
    // `files: false` takes back only the conversation; `conversation: false` only the files.
    const restoreFiles = point.body.files !== false;
    const filesOnly = point.body.conversation === false;
    if (filesOnly && !restoreFiles) {
      // A refused point still answers its refusal first, as before.
      const plan = planRewind(session, turnIndex);
      if (!plan.ok) return refuse(res, plan.code);
      sendError(res, 400, openaiError("files and conversation cannot both be false", "invalid_request_error", "conversation"));
      return;
    }
    const scope = filesOnly ? "files" : restoreFiles ? "all" : "conversation";
    const done = await applySessionRewind(deps, session, turnIndex, scope);
    if (!done.ok) return refuse(res, done.code);
    const { text, restored, deleted, failed, notRestorable, incomplete } = done.value;
    sendJson(res, 200, { id: session.id, text, restored, deleted, failed, notRestorable, incomplete });
  };
}

export function createForkSessionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const point = await readPoint(req, res, ctx);
    if (point === null) return;
    const plan = planFork(point.session, {
      priorQuestions: point.priorQuestions,
      expectText: point.text,
    });
    if (!plan.ok) return refuse(res, plan.code);
    ctx.runtime.sessionStore.save(plan.state);
    sendJson(res, 200, { id: plan.state.id, title: plan.title, sourceId: point.session.id });
  };
}

/**
 * The session and the question the body names, or null once an error
 * was sent. Refuses while a turn runs on the chat (this process's, or
 * one another process on the state dir marked).
 */
async function readPoint(
  req: Parameters<HttpHandler>[0],
  res: ServerResponse,
  ctx: HandlerContext,
): Promise<Point | null> {
  const id = ctx.params.id ?? "";
  let body: { priorQuestions?: unknown; expectText?: unknown; files?: unknown; conversation?: unknown } | null;
  try {
    body = (await readJsonBody<unknown>(req)) as typeof body;
  } catch (err) {
    sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
  const prior = body?.priorQuestions;
  if (typeof prior !== "number" || !Number.isInteger(prior) || prior < 0) {
    sendError(res, 400, openaiError("priorQuestions must be a non-negative integer", "invalid_request_error", "priorQuestions"));
    return null;
  }
  const expectText = body?.expectText;
  if (typeof expectText !== "string") {
    sendError(res, 400, openaiError("expectText must be a string", "invalid_request_error", "expectText"));
    return null;
  }
  const session = ctx.runtime.sessionStore.load(id);
  if (!session) {
    notFound(res, id);
    return null;
  }
  if (ctx.runtime.turnController.isBusy(id)) {
    refuse(res, "turn_in_progress");
    return null;
  }
  const turnIndex = questionRowIndex(session, prior);
  const row = turnIndex < 0 ? undefined : session.turns[turnIndex];
  if (row === undefined || row.kind !== "user" || row.text.trim() !== expectText.trim()) {
    refuse(res, "point_mismatch");
    return null;
  }
  return { session, turnIndex, priorQuestions: prior, text: row.text, at: row.at, body: body ?? {} };
}

function refuse(res: ServerResponse, code: RewindRefusal | ForkRefusal): void {
  sendError(res, 409, openaiError(REFUSAL_MESSAGES[code], "invalid_request_error", null, code));
}

function notFound(res: ServerResponse, id: string): void {
  sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
}
