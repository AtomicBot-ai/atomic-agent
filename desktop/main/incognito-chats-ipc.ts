/**
 * ATO-586 — incognito chats (main/incognito-chats.ts, renderer/incognito-chat.js).
 *
 *   incognito:open    -> { ok: true, id }   a new incognito chat's id
 *   incognito:close   { id } -> { ok }     forget it and delete it on the agent
 *                                          (DELETE /api/sessions/{id}; a turn
 *                                          still running is deleted when it ends)
 *
 * Quitting closes every open one, best effort: the request may not finish
 * before the app is gone, and then the agent's next start deletes the chat
 * (its owner process is gone).
 */

import { app, ipcMain } from "electron";

import type { AgentClient } from "./agent-client.js";
import { closeIncognitoChat, openIncognitoChat, openIncognitoChats } from "./incognito-chats.js";

export function wireIncognitoChatsIpc(client: AgentClient): void {
  ipcMain.handle("incognito:open", () => ({ ok: true, id: openIncognitoChat() }));

  ipcMain.handle("incognito:close", async (_event, payload: unknown) => {
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !closeIncognitoChat(id)) return { ok: false, error: "not an open incognito chat" };
    try {
      await client.deleteSession(id);
      return { ok: true };
    } catch (err) {
      // A chat that never got a turn is not on the agent; and the next start deletes any it still holds.
      return { ok: true, note: err instanceof Error ? err.message : String(err) };
    }
  });

  app.on("before-quit", () => {
    for (const id of openIncognitoChats()) {
      closeIncognitoChat(id);
      void client.deleteSession(id).catch(() => undefined);
    }
  });
}
