/**
 * ATO-639 — `cli:traceTree`, the route behind Settings › Diagnostics'
 * Timeline (renderer/trace-view.js): one chat's trace as turns → steps →
 * model and tool calls (trace-tree.ts). It takes what `cli:traceTools`
 * takes, {stateDir, sessionId}, and refuses a folder outside the desktop's
 * own state, as that route does.
 */

import type { IpcMain } from "electron";

import { underDesktopState } from "./state-dir.js";
import { readTraceTree } from "./trace-tree.js";

export function wireTraceTreeIpc(deps: { ipcMain: Pick<IpcMain, "handle">; ownDir?: (p: string) => boolean }): void {
  const ownDir = deps.ownDir ?? underDesktopState;
  deps.ipcMain.handle("cli:traceTree", (_event, payload: unknown) => {
    const { stateDir, sessionId } = (payload ?? {}) as { stateDir?: unknown; sessionId?: unknown };
    if (typeof stateDir !== "string" || !ownDir(stateDir) || typeof sessionId !== "string") {
      return { ok: false, error: "stateDir and sessionId are required" };
    }
    return readTraceTree(stateDir, sessionId);
  });
}
