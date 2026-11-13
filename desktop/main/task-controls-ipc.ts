/**
 * ATO-590 — the Tasks tab's schedule controls, on the running agent:
 *
 *   agent:pauseTask   POST /api/tasks/{id}/pause   (pending -> paused)
 *   agent:resumeTask  POST /api/tasks/{id}/resume  (paused -> pending; a
 *                     recurring task is armed for its next firing)
 *   agent:taskRuns    GET  /api/tasks/{id}/runs    (its past runs, newest first)
 *
 * Every answer is `{ok, data}` or `{ok:false, error, unsupported}` like the
 * other task routes in main.ts. `unsupported` is an agent from before these
 * routes (404 "no route"): the window then hides Pause and the history.
 */

import { ipcMain } from "electron";

export interface TaskControlsIpcDeps {
  client: {
    pauseTask: (id: string) => Promise<unknown>;
    resumeTask: (id: string) => Promise<unknown>;
    taskRuns: (id: string, limit?: number) => Promise<unknown>;
  };
}

export type TaskControlAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: string; unsupported: boolean };

/** The ids the agent mints (`t-<uuid>`) and nothing that could reshape the path. */
export function cleanTaskId(id: unknown): string | null {
  return typeof id === "string" && /^[\w.-]{1,64}$/.test(id) ? id : null;
}

/** Whether a failed call means the agent has no such route at all. */
export function isUnsupportedRoute(message: string): boolean {
  return /\bno route\b/i.test(message);
}

export async function taskControlCall(fn: () => Promise<unknown>): Promise<TaskControlAnswer> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, unsupported: isUnsupportedRoute(error) };
  }
}

export function wireTaskControlsIpc(deps: TaskControlsIpcDeps): void {
  const refuse: TaskControlAnswer = { ok: false, error: "task id required", unsupported: false };
  ipcMain.handle("agent:pauseTask", (_event, id: unknown) => {
    const clean = cleanTaskId(id);
    return clean ? taskControlCall(() => deps.client.pauseTask(clean)) : refuse;
  });
  ipcMain.handle("agent:resumeTask", (_event, id: unknown) => {
    const clean = cleanTaskId(id);
    return clean ? taskControlCall(() => deps.client.resumeTask(clean)) : refuse;
  });
  ipcMain.handle("agent:taskRuns", (_event, id: unknown) => {
    const clean = cleanTaskId(id);
    return clean ? taskControlCall(() => deps.client.taskRuns(clean, 50)) : refuse;
  });
}
