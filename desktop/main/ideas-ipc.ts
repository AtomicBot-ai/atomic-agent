/**
 * ATO-458 — suggested tasks ("ideas") on the empty chat screen, on the
 * running agent (src/http/route-ideas.ts):
 *
 *   agent:ideasRefresh  POST /api/ideas/refresh       rebuild, answer the `new` ones
 *   agent:ideaAccept    POST /api/ideas/{id}/accept   file the task, answer {idea, task}
 *   agent:ideaDismiss   POST /api/ideas/{id}/dismiss  retire the card for good
 *
 * Every answer is `{ok, data}` or `{ok:false, error, unsupported}`, as the
 * other task routes (task-controls-ipc.ts). `unsupported` covers an agent
 * from before the routes (404 "no route") and one with tasks turned off
 * (404 "tasks subsystem disabled"): the window then shows no cards.
 *
 * Asked only by the window (on start and when it opens a new chat); main
 * runs no timer of its own.
 */

import { ipcMain } from "electron";

export interface IdeasIpcDeps {
  client: {
    refreshIdeas: () => Promise<unknown>;
    acceptIdea: (id: string) => Promise<unknown>;
    dismissIdea: (id: string) => Promise<unknown>;
  };
}

export type IdeaAnswer =
  | { ok: true; data: unknown }
  | { ok: false; error: string; unsupported: boolean };

/** The ids the idea store mints, and nothing that could reshape the path. */
export function cleanIdeaId(id: unknown): string | null {
  return typeof id === "string" && /^[\w.-]{1,64}$/.test(id) ? id : null;
}

/** Whether a failed call means this agent offers no ideas at all. */
export function ideasUnsupported(message: string): boolean {
  return /\bno route\b|tasks subsystem disabled/i.test(message);
}

export async function ideaCall(fn: () => Promise<unknown>): Promise<IdeaAnswer> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error, unsupported: ideasUnsupported(error) };
  }
}

export function wireIdeasIpc(deps: IdeasIpcDeps): void {
  const refuse: IdeaAnswer = { ok: false, error: "idea id required", unsupported: false };
  ipcMain.handle("agent:ideasRefresh", () => ideaCall(() => deps.client.refreshIdeas()));
  ipcMain.handle("agent:ideaAccept", (_event, id: unknown) => {
    const clean = cleanIdeaId(id);
    return clean ? ideaCall(() => deps.client.acceptIdea(clean)) : refuse;
  });
  ipcMain.handle("agent:ideaDismiss", (_event, id: unknown) => {
    const clean = cleanIdeaId(id);
    return clean ? ideaCall(() => deps.client.dismissIdea(clean)) : refuse;
  });
}
