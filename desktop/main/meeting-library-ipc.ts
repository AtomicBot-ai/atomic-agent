/**
 * ATO-2514: Settings, Meetings, the routes (renderer/settings-meetings.js).
 *
 *   meeting:settings-get    {prefs, folder, defaultFolder}: where transcripts go now
 *   meeting:settings-set    a change: {systemAudio}, {voices}, {folder: null} resets the folder
 *   meeting:choose-folder   the system folder picker; the choice becomes the folder
 *   meeting:list            the saved meetings in the folder, newest first
 *   meeting:open            a transcript (or its notes) in the default app
 *   meeting:show            a transcript in Finder / Explorer
 *   meeting:trash           a transcript and its notes to the Trash (the page confirmed first;
 *                           notes that stay behind are error "notes-trash-failed")
 *
 * The page names files only by their name; meeting-library.ts accepts the
 * recorder's own names and nothing else, inside the current folder.
 * Choices are kept in userData/meetings.json (meeting-prefs.ts).
 */
import { existsSync } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { meetingDefaultDir, meetingSaveDir } from "./meeting-ipc.js";
import { listMeetings, meetingFilePath, trashMeeting } from "./meeting-library.js";
import { mergeMeetingPrefs, readMeetingPrefs, writeMeetingPrefs } from "./meeting-prefs.js";

const userData = () => app.getPath("userData");

function settings() {
  return { ok: true, prefs: readMeetingPrefs(userData()), folder: meetingSaveDir(), defaultFolder: meetingDefaultDir() };
}

function save(patch: unknown) {
  const next = mergeMeetingPrefs(readMeetingPrefs(userData()), patch);
  if (!writeMeetingPrefs(userData(), next)) return { ok: false, error: "write-failed" };
  return settings();
}

export function wireMeetingLibraryIpc(): void {
  ipcMain.handle("meeting:settings-get", () => settings());
  ipcMain.handle("meeting:settings-set", (_event, patch: unknown) => save(patch));

  ipcMain.handle("meeting:choose-folder", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      title: "Choose where meeting transcripts are saved",
      defaultPath: meetingSaveDir(),
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)).catch(() => null);
    if (!res || res.canceled || !res.filePaths[0]) return { ok: false, error: "cancelled" };
    return save({ folder: res.filePaths[0] });
  });

  ipcMain.handle("meeting:list", () => {
    const folder = meetingSaveDir();
    return { ok: true, folder, items: listMeetings(folder) };
  });

  ipcMain.handle("meeting:open", async (_event, name: unknown, which: unknown) => {
    const path = meetingFilePath(meetingSaveDir(), name);
    if (!path) return { ok: false, error: "not-found" };
    const target = which === "notes" ? path.replace(/\.txt$/, ".notes.md") : path;
    if (!existsSync(target)) return { ok: false, error: "not-found" };
    const err = await shell.openPath(target).catch(() => "failed");
    return err ? { ok: false, error: "open-failed" } : { ok: true };
  });

  ipcMain.handle("meeting:show", (_event, name: unknown) => {
    const path = meetingFilePath(meetingSaveDir(), name);
    if (!path || !existsSync(path)) return { ok: false, error: "not-found" };
    shell.showItemInFolder(path);
    return { ok: true };
  });

  ipcMain.handle("meeting:trash", (_event, name: unknown) => trashMeeting(meetingSaveDir(), name, (path) => shell.trashItem(path)));
}
