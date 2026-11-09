/**
 * ATO-1113 (desktop half): the "Run overnight" routes.
 *
 *   overnight:pickFolder  the native folder dialog, opened at the folder the
 *                         dialog shows; answers the picked path or null. It
 *                         only picks: the chat's own folder does not change.
 *   overnight:start       the dialog's input → `POST /api/tasks` on the
 *                         running agent (overnight-task.ts builds the body).
 *                         The agent starts the task itself (`tasks.runOnCreate`,
 *                         else the scheduler's next tick). A remote agent works
 *                         in its own folder, never in one picked on this computer.
 *
 * Elapsed time, spend and Stop reuse the task routes the Tasks tab already
 * has (`agent:task`, `agent:cancelTask`).
 */

import { dialog, ipcMain, type BrowserWindow } from "electron";

import * as A from "./analytics/index.js";
import { overnightErrorText, overnightTaskBody, remoteAgentFolder } from "./overnight-task.js";

export interface OvernightIpcDeps {
  window: () => BrowserWindow | null;
  client: {
    status: { state: string; workingDir: string };
    isRemote: boolean;
    /** `GET /health?llama=0`: a remote agent reports its own folder here. */
    turnsHealth: () => Promise<unknown>;
    createTask: (body: Record<string, unknown>) => Promise<unknown>;
  };
}

export function wireOvernightIpc(deps: OvernightIpcDeps): void {
  ipcMain.handle("overnight:pickFolder", async (_event, current: unknown) => {
    const win = deps.window();
    const opts = {
      title: "Folder for the overnight run",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      defaultPath: typeof current === "string" && current ? current : deps.client.status.workingDir,
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
  });

  ipcMain.handle("overnight:start", async (_event, input: unknown) => {
    const notRunning = { ok: false, error: "The agent is not running. Start it and try again." };
    let remoteFolder: string | undefined;
    if (deps.client.isRemote) {
      if (deps.client.status.state !== "connected") return notRunning;
      const folder = remoteAgentFolder(await deps.client.turnsHealth().catch(() => null));
      if (!folder) return { ok: false, error: "The agent on the other computer did not say which folder it works in." };
      remoteFolder = folder;
    }
    const checked = overnightTaskBody(input, remoteFolder);
    if (!checked.ok) return checked;
    if (deps.client.status.state !== "connected") return notRunning;
    try {
      const task = (await deps.client.createTask({ ...checked.body })) as { id?: unknown } | null;
      if (!task || typeof task.id !== "string") return { ok: false, error: "The agent did not return a task." };
      A.overnightStarted(checked.request);
      return { ok: true, task };
    } catch (err) {
      return { ok: false, error: overnightErrorText(err instanceof Error ? err.message : String(err), deps.client.isRemote) };
    }
  });
}
