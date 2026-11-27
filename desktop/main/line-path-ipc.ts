/**
 * ATO-2445: `app:resolveLinePath`, where a reply's `path:line` chip points
 * (line-path.ts does the work).
 *
 *   app:resolveLinePath({ sessionId, path }) → { ok: true, path } | { ok: false, reason }
 *
 * The folder is never taken from the window: main picks the chat's working
 * folder from the session, as `mentions:search` does (file-mentions-ipc.ts).
 * A remote agent's folder is on another computer, so a relative path finds
 * nothing there. The listing for a bare name is the @-mention index of that
 * folder (cached 15 s), its own instance here.
 */

import { homedir } from "node:os";
import { ipcMain } from "electron";

import { createMentionFileIndex, mentionFolder } from "./file-mentions.js";
import { resolveLinePath } from "./line-path.js";

const MAX_SESSION_ID = 256;

export interface LinePathDeps {
  isRemote(): boolean;
  /** The agent's folder for a chat, or nothing when it names none. */
  sessionDir(sessionId: string | null): Promise<string | undefined>;
  /** The agent's own folder, when a chat has none. */
  defaultDir(): string;
}

export function wireLinePathIpc(deps: LinePathDeps): void {
  const index = createMentionFileIndex();
  ipcMain.handle("app:resolveLinePath", async (_event, payload: unknown) => {
    const { sessionId, path } = (payload ?? {}) as { sessionId?: unknown; path?: unknown };
    const sid = typeof sessionId === "string" && sessionId && sessionId.length <= MAX_SESSION_ID ? sessionId : null;
    let dir: string | undefined;
    try { dir = (await deps.sessionDir(sid)) || undefined; } catch { dir = undefined; }
    const folder = mentionFolder(deps.isRemote(), dir ?? deps.defaultDir());
    const r = await resolveLinePath(path, folder, homedir(), process.platform, (root) => index.list(root));
    if (!r.ok && r.reason === "missing" && deps.isRemote()) return { ok: false, reason: "remote" };
    return r;
  });
}
