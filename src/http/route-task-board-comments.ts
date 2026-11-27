import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import { getConfig } from "../config/index.js";
import { loadRuntimeAgentProfiles } from "../runtime/agent-profile-sources.js";
import { validateBoardComment, type BoardComment } from "../tasks/index.js";

/**
 * A card's comment thread and the profiles it can be assigned to
 * (ATO-2498), beside the board routes in `route-task-board.ts`.
 */

/** Most comments one answer holds. */
const COMMENTS_LIMIT_MAX = 200;

/**
 * `GET /api/tasks/:id/board/comments?limit=N`: `{ comments, available }`,
 * newest first; a comment is `{ id, author, kind, text, createdAt }`,
 * `author` being `agent`, `person` or `system`. `available: false` when
 * this agent keeps no comments on its tasks file. 404 unknown task.
 */
export function createListBoardCommentsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    const store = ctx.runtime.taskStore;
    if (!id || !store.get(id)) {
      sendError(res, 404, openaiError(`task not found: ${id ?? ""}`));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const limitParam = url.searchParams.get("limit");
    let limit = 50;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, COMMENTS_LIMIT_MAX);
    }
    sendJson(res, 200, {
      comments: store.listBoardComments(id, limit).map(commentToJson),
      available: store.boardCommentsUnavailable === null,
    });
  };
}

/**
 * `POST /api/tasks/:id/board/comments` with `{ text }`: a person's
 * comment on the card (the board, `atag task comment`). 201 with the
 * comment, 400 for empty or too long text, 404 unknown task, 503 when
 * comments are off for this file.
 */
export function createAddBoardCommentHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    const store = ctx.runtime.taskStore;
    if (!id || !store.get(id)) {
      sendError(res, 404, openaiError(`task not found: ${id ?? ""}`));
      return;
    }
    if (store.boardCommentsUnavailable !== null) {
      sendError(res, 503, openaiError(`card comments unavailable: ${store.boardCommentsUnavailable}`));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "invalid body"));
      return;
    }
    const checked = validateBoardComment(body?.text);
    if ("error" in checked) {
      sendError(res, 400, openaiError(checked.error, "invalid_request_error", "text"));
      return;
    }
    const comment = store.addBoardComment(id, { author: "person", kind: "comment", text: checked.text });
    if (!comment) {
      sendError(res, 503, openaiError("card comments unavailable"));
      return;
    }
    sendJson(res, 201, commentToJson(comment));
  };
}

/**
 * `GET /api/task-board/profiles?taskId=ID`: the agent profiles a card can
 * be assigned to, `{ profiles: [{ name, description, source }] }`, read
 * from the same sources a run uses, for the task's folder when `taskId`
 * names one (project profiles), else the agent's own folder.
 */
export function createBoardProfilesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const taskId = url.searchParams.get("taskId");
    let dir = process.cwd();
    if (taskId) {
      const task = ctx.runtime.taskStore.get(taskId);
      if (!task) {
        sendError(res, 404, openaiError(`task not found: ${taskId}`));
        return;
      }
      dir = ctx.runtime.sessionStore.load(task.sessionId)?.workingDir ?? dir;
    }
    const set = loadRuntimeAgentProfiles(getConfig(), dir);
    sendJson(res, 200, {
      profiles: set.profiles
        .map((p) => ({ name: p.name, description: p.description, source: p.source }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  };
}

export function commentToJson(comment: BoardComment): Record<string, unknown> {
  return {
    id: comment.id,
    author: comment.author,
    kind: comment.kind,
    text: comment.text,
    createdAt: comment.createdAt,
  };
}
