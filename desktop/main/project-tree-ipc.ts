/**
 * ATO-2445: `files:tree`, one folder of the chat's project tree
 * (project-tree.ts does the work).
 *
 *   files:tree({ sessionId, rel }) → { ok: true, root, name, rel, entries, cut, git }
 *                                  | { ok: false, reason: "no-folder" | "remote" | "outside" | "missing" | "not-dir" }
 *
 * The folder is never taken from the window: main picks the chat's working
 * folder from the session, as `mentions:search` does (file-mentions-ipc.ts),
 * and the window only says which folder under it to open. A remote agent's
 * folder is on another computer, so there is no tree for it here.
 */

import { ipcMain } from "electron";

import { listTreeDir } from "./project-tree.js";
import { lastSegment } from "./platform.js";

const MAX_SESSION_ID = 256;

export interface ProjectTreeDeps {
  isRemote(): boolean;
  sessionDir(sessionId: string | null): Promise<string | undefined>;
  defaultDir(): string;
  /** The preview's roots: the tree never shows a folder the preview could not read. */
  previewRoots(): string[];
}

export function wireProjectTreeIpc(deps: ProjectTreeDeps): void {
  ipcMain.handle("files:tree", async (_event, payload: unknown) => {
    const { sessionId, rel } = (payload ?? {}) as { sessionId?: unknown; rel?: unknown };
    if (deps.isRemote()) return { ok: false, reason: "remote" };
    const sid = typeof sessionId === "string" && sessionId && sessionId.length <= MAX_SESSION_ID ? sessionId : null;
    let dir: string | undefined;
    try { dir = (await deps.sessionDir(sid)) || undefined; } catch { dir = undefined; }
    const root = dir ?? deps.defaultDir();
    if (!root) return { ok: false, reason: "no-folder" };
    try {
      const r = await listTreeDir(root, rel, deps.previewRoots(), process.platform);
      return r.ok ? { ...r, name: lastSegment(process.platform, r.root) ?? r.root } : r;
    } catch {
      return { ok: false, reason: "missing" };
    }
  });
}
