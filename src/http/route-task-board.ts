import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import { recordToJson } from "./route-tasks.js";
import {
  BOARD_LANES,
  BoardValidationError,
  groupCardsByLane,
  validateBoardPatch,
  type BoardCard,
} from "../tasks/index.js";

/**
 * The task board (ATO-2257): agent tasks as cards in five lanes
 * (`todo`, `doing`, `review`, `blocked`, `done`), the way Vibe Kanban
 * and the Hermes/OpenClaw workboards show agent work. The board is a
 * view over the queue: a card's lane comes from the task's status
 * unless someone moved it, and moving a card never changes the status.
 * Running a card uses the existing `POST /api/tasks/:id/run`. An agent
 * from before these routes answers 404 "no route"; the desktop then
 * shows its plain task list.
 */

/** Most cards one board answer holds, as `GET /api/tasks` caps its list. */
const BOARD_LIMIT_MAX = 500;

/**
 * `GET /api/task-board?limit=N`: `{ lanes: ["todo", ...], cards: [card],
 * counts: { todo: n, ... }, available }`, newest task first. A card is
 * `{ task, lane, laneSource, note, assignee, boardUpdatedAt }`, `task`
 * being the same record `GET /api/tasks/:id` answers. `available: false`
 * when this agent could not keep a board on its tasks file: cards are
 * then in their status lanes and moves are refused. Default limit 200.
 */
export function createTaskBoardHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const limitParam = url.searchParams.get("limit");
    let limit = 200;
    if (limitParam !== null) {
      const parsed = Number.parseInt(limitParam, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        sendError(res, 400, openaiError("limit must be a positive integer"));
        return;
      }
      limit = Math.min(parsed, BOARD_LIMIT_MAX);
    }
    const store = ctx.runtime.taskStore;
    const cards = store.boardCards({ limit });
    const grouped = groupCardsByLane(cards);
    const counts = Object.fromEntries(BOARD_LANES.map((lane) => [lane, grouped[lane].length]));
    sendJson(res, 200, {
      lanes: [...BOARD_LANES],
      cards: cards.map(cardToJson),
      counts,
      available: store.boardUnavailable === null,
    });
  };
}

/**
 * `POST /api/tasks/:id/board` with `{ lane?, note?, assignee? }`: move
 * the card and/or change its note or assignee (an agent profile name).
 * A field left out keeps its value; `null` clears it (a cleared lane
 * goes back to the one the status gives). 200 with the card, 400 for a
 * bad field, 404 unknown task, 503 when the board is off for this file.
 */
export function createUpdateTaskBoardCardHandler(): HttpHandler {
  return async (req, res, ctx) => {
    if (!ctx.runtime.config.tasks.enabled) {
      sendError(res, 404, openaiError("tasks subsystem disabled"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("task id is required"));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody<Record<string, unknown>>(req);
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "invalid body"));
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const store = ctx.runtime.taskStore;
    if (store.boardUnavailable !== null) {
      sendError(res, 503, openaiError(`task board unavailable: ${store.boardUnavailable}`));
      return;
    }
    try {
      const patch = validateBoardPatch({ lane: body.lane, note: body.note, assignee: body.assignee });
      const card = store.updateBoardCard(id, patch);
      if (!card) {
        sendError(res, 404, openaiError(`task not found: ${id}`));
        return;
      }
      sendJson(res, 200, cardToJson(card));
    } catch (err) {
      if (err instanceof BoardValidationError) {
        sendError(res, 400, openaiError(err.message, "invalid_request_error", err.field));
        return;
      }
      throw err;
    }
  };
}

export function cardToJson(card: BoardCard): Record<string, unknown> {
  return {
    task: recordToJson(card.task),
    lane: card.lane,
    laneSource: card.laneSource,
    note: card.note,
    assignee: card.assignee,
    boardUpdatedAt: card.boardUpdatedAt,
  };
}
