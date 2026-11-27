/**
 * ATO-1624: the "My files" routes between the window and the running agent.
 *
 *   files:pickFolder    the native folder dialog; answers `{ok, path}` (path
 *                       null when cancelled). Refused on a remote agent: the
 *                       dialog would show this computer's disks.
 *   files:addFolder     `POST /api/files/folders {path}`; refused on a remote agent.
 *   files:removeFolder  `DELETE /api/files/folders {path}`; refused on a remote agent.
 *   files:listFolders   `GET /api/files/folders`. Checks `/api/capabilities`
 *                       first: an agent without `fileIndex` is `unsupported`.
 *   files:status        `GET /api/files/status`, the progress the screen polls.
 *   files:retry         `POST /api/files/retry` (ATO-2501): read the skipped scans,
 *                       photos and audio again; refused on a remote agent.
 *
 * Main reads no files itself: the agent walks and indexes the folders
 * (main/my-files.ts has the parsing, test/my-files.test.mjs tests it).
 */

import { dialog, ipcMain, type BrowserWindow } from "electron";

import {
  MY_FILES_TEXT,
  addFolder,
  hasFileIndex,
  indexStatus,
  listFolders,
  pickRefusal,
  removeFolder,
  retrySkipped,
  type MyFilesTarget,
} from "./my-files.js";

export interface MyFilesIpcDeps {
  window: () => BrowserWindow | null;
  client: {
    isRemote: boolean;
    status: { state: string; workingDir: string };
    capabilities: () => Promise<unknown>;
    /** `{ base, headers }` of the running agent; throws when there is none. */
    filesTarget: () => MyFilesTarget;
  };
}

export function wireMyFilesIpc(deps: MyFilesIpcDeps): void {
  const env = {
    isRemote: () => deps.client.isRemote,
    target: () => deps.client.filesTarget(),
  };

  ipcMain.handle("files:pickFolder", async () => {
    const refused = pickRefusal(deps.client.isRemote);
    if (refused) return refused;
    const win = deps.window();
    const opts = {
      title: "Add a folder to My files",
      buttonLabel: "Add folder",
      properties: ["openDirectory"] as Array<"openDirectory">,
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return { ok: true, path: picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0] };
  });

  ipcMain.handle("files:addFolder", (_event, path: unknown) => addFolder(env, path));
  ipcMain.handle("files:removeFolder", (_event, path: unknown) => removeFolder(env, path));

  ipcMain.handle("files:listFolders", async () => {
    if (deps.client.status.state !== "connected") return { ok: false, reason: "not_running", error: MY_FILES_TEXT.notRunning };
    // An agent that answers capabilities without `fileIndex` has no index; one
    // that does not answer is asked the route itself (its 404/501 says the same).
    const caps = await deps.client.capabilities().catch(() => undefined);
    if (caps !== undefined && !hasFileIndex(caps)) return { ok: false, reason: "unsupported", error: MY_FILES_TEXT.unsupported };
    const listed = await listFolders(env);
    return listed.ok ? { ...listed, remote: deps.client.isRemote } : listed;
  });

  ipcMain.handle("files:status", () => indexStatus(env));
  ipcMain.handle("files:retry", () => retrySkipped(env));
}
