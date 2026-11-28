/**
 * ATO-1593 / ATO-1595 — the `@file` mention routes (file-mentions.ts does the
 * work and says why it is built this way).
 *
 *   mentions:search({ sessionId, query }) → { ok: true, paths, filesError? } | { ok: false, error }
 *
 * The folder is never taken from the window: main picks it from the session,
 * the way `cli:skillList` does (the agent's own `workingDir` for the chat,
 * else the agent's folder). A remote agent's folder is on another computer,
 * so it gets no paths and no expansion.
 *
 * `expand` is what `agent:chat` calls on a turn's messages before they go out.
 * ATO-2241 / ATO-2472: the agent inlines `@file`, `@diff`, `@git:N`,
 * `@path:10-40`, `@folder/`, `@https://...` and `@problems` with the
 * terminal's code (mention-core.ts); the palette offers those words above
 * the files, and folders next to them (mention-kinds.ts).
 */

import { ipcMain } from "electron";

import {
  MAX_MENTION_RESULTS,
  createMentionFileIndex,
  mentionFolder,
  rankMentionFiles,
} from "./file-mentions.js";
import { expandLastUserMessageViaCore, type ExpandInCore } from "./mention-core.js";
import { contextSuggestions, foldersOf } from "./mention-kinds.js";

const MAX_QUERY = 256;
const MAX_SESSION_ID = 256;

export interface FileMentionsDeps {
  isRemote(): boolean;
  /** The agent's folder for a chat (`null`: a new chat), or nothing when it has none. */
  sessionDir(sessionId: string | null): Promise<string | undefined>;
  /** The agent's own folder, when a chat has none. */
  defaultDir(): string;
  /** ATO-2472: the agent's expansion (`POST /api/mentions/expand`). */
  expandInCore: ExpandInCore;
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
    const sid = typeof sessionId === "string" && sessionId ? sessionId : null;
    const folder = mentionFolder(false, (await dirOf(sid)) ?? deps.defaultDir());
    const words = folder ? contextSuggestions(q) : [];
    try {
      if (!folder) return { ok: true, paths: [] };
      // ATO-2472: folders (`src/`) are offered next to the files, from the listed paths.
      const files = await index.list(folder);
      const found = rankMentionFiles(q, [...foldersOf(files), ...files], MAX_MENTION_RESULTS);
      const paths = [...words, ...found.filter((p) => !words.includes(p))];
      return { ok: true, paths: paths.slice(0, MAX_MENTION_RESULTS) };
    } catch (err) {
      // ATO-2751: a failed listing still offers `@diff` / `@git:N` / a typed link; the window says the files failed.
      const error = err instanceof Error ? err.message : String(err);
      return words.length ? { ok: true, paths: words, filesError: error } : { ok: false, error };
    }
  });

  return {
    async expand(messages, sessionId, turnDir) {
      if (deps.isRemote() || !messages.some((m) => m.content.includes("@"))) return messages;
      try {
        const dir = (sessionId ? await dirOf(sessionId) : undefined) ?? turnDir();
        return await expandLastUserMessageViaCore(messages, mentionFolder(false, dir), deps.expandInCore);
      } catch {
        return messages;
      }
    },
  };
}
