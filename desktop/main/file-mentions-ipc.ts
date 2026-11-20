/**
 * ATO-1593 / ATO-1595 — the `@file` mention routes (file-mentions.ts does the
 * work and says why it is built this way).
 *
 *   mentions:search({ sessionId, query }) → { ok: true, paths } | { ok: false, error }
 *
 * The folder is never taken from the window: main picks it from the session,
 * the way `cli:skillList` does (the agent's own `workingDir` for the chat,
 * else the agent's folder). A remote agent's folder is on another computer,
 * so it gets no paths and no expansion.
 *
 * `expand` is what `agent:chat` calls on a turn's messages before they go out.
 */

import { ipcMain } from "electron";

import {
  createMentionFileIndex,
  expandLastUserMessage,
  mentionFolder,
  searchMentions,
} from "./file-mentions.js";

const MAX_QUERY = 256;
const MAX_SESSION_ID = 256;

export interface FileMentionsDeps {
  isRemote(): boolean;
  /** The agent's folder for a chat (`null`: a new chat), or nothing when it has none. */
  sessionDir(sessionId: string | null): Promise<string | undefined>;
  /** The agent's own folder, when a chat has none. */
  defaultDir(): string;
}

export interface FileMentions {
  /**
   * The turn's messages with the last user message's mentions inlined.
   * `sessionId` is the stored chat (`null` for a new one); `turnDir` gives
   * the folder the turn runs in, used when the agent names none for the chat.
   */
  expand<T extends { role: string; content: string }>(
    messages: T[], sessionId: string | null, turnDir: () => string | undefined,
  ): Promise<T[]>;
}

export function wireFileMentionsIpc(deps: FileMentionsDeps): FileMentions {
  const index = createMentionFileIndex();

  const dirOf = async (sessionId: string | null): Promise<string | undefined> => {
    try {
      return (await deps.sessionDir(sessionId)) || undefined;
    } catch {
      return undefined;
    }
  };

  ipcMain.handle("mentions:search", async (_event, payload: unknown) => {
    const { sessionId, query } = (payload ?? {}) as { sessionId?: unknown; query?: unknown };
    if (sessionId != null && (typeof sessionId !== "string" || sessionId.length > MAX_SESSION_ID)) {
      return { ok: false, error: "invalid session id" };
    }
    const q = typeof query === "string" ? query.slice(0, MAX_QUERY) : "";
    if (deps.isRemote()) return { ok: true, paths: [] };
    try {
      const sid = typeof sessionId === "string" && sessionId ? sessionId : null;
      const folder = mentionFolder(false, (await dirOf(sid)) ?? deps.defaultDir());
      return await searchMentions(index, folder, q);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  return {
    async expand(messages, sessionId, turnDir) {
      if (deps.isRemote() || !messages.some((m) => m.content.includes("@"))) return messages;
      try {
        const dir = (sessionId ? await dirOf(sessionId) : undefined) ?? turnDir();
        return expandLastUserMessage(messages, mentionFolder(false, dir));
      } catch {
        return messages;
      }
    },
  };
}
