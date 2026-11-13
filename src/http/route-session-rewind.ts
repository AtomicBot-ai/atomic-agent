import type { ServerResponse } from "node:http";

import type { ConversationTurn } from "../session/conversation-turn.js";
import { planFork, questionRowIndex, type ForkRefusal } from "../session/session-fork.js";
import { listRewindPoints, planRewind, type RewindRefusal } from "../session/session-rewind.js";
import type { SessionState } from "../session/session-state.js";
import {
  applyFileRestore,
  planFileRestore,
  uncoveredToolCalls,
} from "../tools/os/fs/fs-checkpoint-restore.js";
import { FileCheckpointStore, fileCheckpointsRoot } from "../tools/os/fs/fs-checkpoint-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

/**
 * Taking a chat back to one of its questions with its files, and forking
 * it from one (ATO-1056, ATO-1058):
 *
 *  - `GET  /api/sessions/{id}/rewind-points` — the questions it can go back to.
 *  - `POST /api/sessions/{id}/rewind/preview` — what a rollback would do.
 *  - `POST /api/sessions/{id}/rewind` — do it: files first, then the chat.
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
 * commands, archive extractions and Fusion runs whose changes stay.
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
  body: { files?: unknown };
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
    const { session, turnIndex, text, at } = point;
    const plan = planRewind(session, turnIndex);
    if (!plan.ok) return refuse(res, plan.code);
    const store = checkpointStore(ctx);
    const files = await planFileRestore(store, session.id, at);
    const removed = session.turns.slice(turnIndex);
    const notRestorable = files.notRestorable;
    if (preview) {
      sendJson(res, 200, {
        id: session.id,
        turnIndex,
        text,
        removed: removedCounts(removed),
        files: files.items.map((item) => ({ path: item.path, action: item.action })),
        notRestorable,
        incomplete: files.incomplete,
        uncovered: uncoveredToolCalls(removed),
      });
      return;
    }
    // `files: false` takes back only the conversation.
    const restoreFiles = point.body.files !== false;
    // A compaction started on this chat would summarise the rows removed.
    ctx.runtime.cancelSessionCompaction(session.id);
    const done = restoreFiles
      ? await applyFileRestore(store, session.id, files)
      : { restored: [], deleted: [], failed: [] };
    ctx.runtime.sessionStore.save(plan.state);
    ctx.runtime.sessionStore.clearTurnProgress(session.id);
    // The turns those copies belong to are gone.
    await store.dropSince(session.id, at);
    sendJson(res, 200, {
      id: session.id,
      text,
      ...done,
      notRestorable: restoreFiles ? notRestorable : [],
      incomplete: restoreFiles && files.incomplete,
    });
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
  let body: { priorQuestions?: unknown; expectText?: unknown; files?: unknown } | null;
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

function removedCounts(rows: readonly ConversationTurn[]): { questions: number; replies: number } {
  let questions = 0;
  let replies = 0;
  for (const row of rows) {
    if (row.kind === "user" && row.steered !== true) questions += 1;
    if (row.kind === "assistant_reply" && row.progressNote !== true && row.stopped !== true) replies += 1;
  }
  return { questions, replies };
}

function checkpointStore(ctx: HandlerContext): FileCheckpointStore {
  return new FileCheckpointStore(fileCheckpointsRoot(ctx.runtime.config.paths.stateDir));
}

function refuse(res: ServerResponse, code: RewindRefusal | ForkRefusal): void {
  sendError(res, 409, openaiError(REFUSAL_MESSAGES[code], "invalid_request_error", null, code));
}

function notFound(res: ServerResponse, id: string): void {
  sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
}
