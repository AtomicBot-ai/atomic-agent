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
 * ATO-2241: it also inlines `@diff`, `@git:N`, `@path:10-40`, `@folder/` and
 * `@https://...` (context-mentions.ts), and the palette offers those words
 * above the files (mention-kinds.ts).
 */

import { ipcMain } from "electron";

import { expandLastUserMessageWithContext } from "./context-mentions.js";
import {
  MAX_MENTION_RESULTS,
  createMentionFileIndex,
  mentionFolder,
  searchMentions,
} from "./file-mentions.js";
import { contextSuggestions } from "./mention-kinds.js";

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
      const found = await searchMentions(index, folder, q);
      const words = folder ? contextSuggestions(q) : [];
      if (words.length === 0) return found;
      const paths = [...words, ...found.paths.filter((p) => !words.includes(p))];
      return { ok: true, paths: paths.slice(0, MAX_MENTION_RESULTS) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  return {
    async expand(messages, sessionId, turnDir) {
      if (deps.isRemote() || !messages.some((m) => m.content.includes("@"))) return messages;
      try {
        const dir = (sessionId ? await dirOf(sessionId) : undefined) ?? turnDir();
        return await expandLastUserMessageWithContext(messages, mentionFolder(false, dir));
      } catch {
        return messages;
      }
    },
  };
}
