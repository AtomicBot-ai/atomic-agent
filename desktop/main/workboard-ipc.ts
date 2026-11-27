/**
 * ATO-2257: the task board's two calls on the running agent:
 *
 *   agent:taskBoard      GET  /api/task-board          (cards in lanes)
 *   agent:moveTaskCard   POST /api/tasks/{id}/board    (lane, note, assignee)
 *
 * "Run now" on a card is the existing agent:runTask (main.ts). Answers are
 * `{ok, data}` or `{ok:false, error, unsupported}` like task-controls-ipc.ts;
 * `unsupported` is an agent from before the board routes (404 "no route"),
 * and the board then says so instead of showing empty lanes.
 */

import { ipcMain } from "electron";

import { cleanTaskId, taskControlCall, type TaskControlAnswer } from "./task-controls-ipc.js";
import { cleanBoardMove } from "./workboard-move.js";

export interface WorkboardIpcDeps {
  client: {
    taskBoard: (limit?: number) => Promise<unknown>;
    moveTaskCard: (id: string, body: Record<string, unknown>) => Promise<unknown>;
  };
}

export function wireWorkboardIpc(deps: WorkboardIpcDeps): void {
  ipcMain.handle("agent:taskBoard", () => taskControlCall(() => deps.client.taskBoard(200)));
  ipcMain.handle("agent:moveTaskCard", (_event, id: unknown, patch: unknown): Promise<TaskControlAnswer> | TaskControlAnswer => {
    const clean = cleanTaskId(id);
    if (!clean) return { ok: false, error: "task id required", unsupported: false };
    const move = cleanBoardMove(patch);
    if (!move.ok) return { ok: false, error: move.error, unsupported: false };
    return taskControlCall(() => deps.client.moveTaskCard(clean, move.body));
  });
}
