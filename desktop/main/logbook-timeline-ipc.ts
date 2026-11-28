/**
 * ATO-2526: Settings › Logbook and the day timeline, on the running agent
 * (src/http/route-logbook.ts), through logbook-ipc.ts's client:
 *
 *   logbook:refresh  GET    /api/logbook             the state, read fresh
 *   logbook:save     PATCH  /api/logbook/settings    on/off and the preferences
 *   logbook:day      GET    /api/logbook/day?day=    one day's notes
 *   logbook:delete   DELETE /api/logbook/entries     some notes, or the whole day
 *   app:logbookTimeline  (push) the menu bar's "Open the timeline"
 *
 * Answers are `{ok:true, ...}` or `{ok:false, error}` in plain words.
 */

import { ipcMain, type BrowserWindow } from "electron";

import type { LogbookControl } from "./logbook-ipc.js";
import { logbookErrorText, parseLogbookView } from "./logbook-mark.js";
import { cleanDay, logbookDeleteBody, logbookSaveBody, parseLogbookDay } from "./logbook-prefs.js";

const REMOTE = { ok: false as const, error: "The logbook is set on the computer it runs on." };

export function wireLogbookTimelineIpc(control: LogbookControl, isRemote: () => boolean): void {
  ipcMain.handle("logbook:refresh", () => control.refresh());

  ipcMain.handle("logbook:save", async (_event, input: unknown) => {
    if (isRemote()) return REMOTE;
    const body = logbookSaveBody(input);
    if (typeof body === "string") return { ok: false, error: body };
    const r = await control.call("PATCH", "/api/logbook/settings", body);
    if (!r.ok) return { ok: false, error: logbookErrorText(r.status, r.data) };
    const view = parseLogbookView(r.data);
    control.push(view);
    void control.beat();
    return { ok: true, view };
  });

  ipcMain.handle("logbook:day", async (_event, day: unknown) => {
    if (isRemote()) return REMOTE;
    const clean = cleanDay(day);
    if (!clean) return { ok: false, error: "That is not a day." };
    const r = await control.call("GET", `/api/logbook/day?day=${encodeURIComponent(clean)}`);
    if (!r.ok) return { ok: false, error: logbookErrorText(r.status, r.data) };
    const parsed = parseLogbookDay(r.data);
    return parsed ? { ok: true, ...parsed } : { ok: false, error: logbookErrorText(0, null) };
  });

  ipcMain.handle("logbook:delete", async (_event, input: unknown) => {
    if (isRemote()) return REMOTE;
    const body = logbookDeleteBody(input);
    if (!body) return { ok: false, error: "Nothing to delete." };
    const r = await control.call("DELETE", "/api/logbook/entries", body);
    if (!r.ok) return { ok: false, error: logbookErrorText(r.status, r.data) };
    const removed = r.data && typeof r.data === "object" ? (r.data as { removed?: unknown }).removed : 0;
    void control.refresh();
    return { ok: true, removed: typeof removed === "number" ? removed : 0 };
  });
}

/** The menu bar's "Open the timeline": the window, then the timeline in it once it has loaded. */
export function showLogbookTimeline(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  const send = () => { if (!win.isDestroyed()) win.webContents.send("app:logbookTimeline"); };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}
