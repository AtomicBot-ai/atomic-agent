/**
 * ATO-2257: the task board's two calls on the running agent:
 *
 *   agent:taskBoard      GET  /api/task-board          (cards in lanes)
 *   agent:moveTaskCard   POST /api/tasks/{id}/board    (lane, note, assignee, dependsOn)
 *
 * and ATO-2498's card thread and profile picker:
 *
 *   agent:boardComments    GET  /api/tasks/{id}/board/comments
 *   agent:addBoardComment  POST /api/tasks/{id}/board/comments  ({text})
 *   agent:boardProfiles    GET  /api/task-board/profiles?taskId=
 *
 * "Run now" on a card is the existing agent:runTask (main.ts). Answers are
 * `{ok, data}` or `{ok:false, error, unsupported}` like task-controls-ipc.ts;
 * `unsupported` is an agent from before the board routes (404 "no route"),
 * and the board then says so instead of showing empty lanes.
 */

import { ipcMain } from "electron";

import { cleanTaskId, taskControlCall, type TaskControlAnswer } from "./task-controls-ipc.js";
import { cleanBoardComment, cleanBoardMove } from "./workboard-move.js";

export interface WorkboardIpcDeps {
  client: {
    taskBoard: (limit?: number) => Promise<unknown>;
    moveTaskCard: (id: string, body: Record<string, unknown>) => Promise<unknown>;
    boardComments: (id: string) => Promise<unknown>;
    addBoardComment: (id: string, text: string) => Promise<unknown>;
    boardProfiles: (taskId?: string) => Promise<unknown>;
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
  ipcMain.handle("agent:boardComments", (_event, id: unknown): Promise<TaskControlAnswer> | TaskControlAnswer => {
    const clean = cleanTaskId(id);
    if (!clean) return { ok: false, error: "task id required", unsupported: false };
    return taskControlCall(() => deps.client.boardComments(clean));
  });
  ipcMain.handle("agent:addBoardComment", (_event, id: unknown, text: unknown): Promise<TaskControlAnswer> | TaskControlAnswer => {
    const clean = cleanTaskId(id);
    if (!clean) return { ok: false, error: "task id required", unsupported: false };
    const comment = cleanBoardComment(text);
    if (!comment.ok) return { ok: false, error: comment.error, unsupported: false };
    return taskControlCall(() => deps.client.addBoardComment(clean, comment.text));
  });
  ipcMain.handle("agent:boardProfiles", (_event, taskId: unknown) => {
    const clean = cleanTaskId(taskId);
    return taskControlCall(() => deps.client.boardProfiles(clean ?? undefined));
  });
}
