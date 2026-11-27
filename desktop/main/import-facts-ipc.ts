/**
 * ATO-1629 / ATO-1061: the routes of "Here is what I learned about you"
 * (renderer/import-facts.js). The logic is import-facts.ts; this file only
 * registers it and opens the file dialog for a ChatGPT export.
 *
 *   importFacts:info    whether the agent has the step, the cloud models to offer
 *   importFacts:pick    the native dialog for the export .zip
 *   importFacts:start / job / stop / forget / save   the agent's /api/import/facts/*
 *
 * The start payload is checked in full before the agent is asked
 * (import-facts-input.ts, ATO-1656): a renderer value is not trusted here.
 */

import { dialog, ipcMain, type BrowserWindow } from "electron";

import * as A from "./analytics/index.js";
import { createImportFactsHandlers, type ImportFactsDeps } from "./import-facts.js";

export function wireImportFactsIpc(deps: { window: () => BrowserWindow | null; client: ImportFactsDeps["client"] }): void {
  const h = createImportFactsHandlers({
    client: deps.client,
    onFound: (i) => A.importFactsStep({ step: "found", source: i.source, local: i.local, state: i.state, found: i.found, saved: 0, skipped: 0 }),
    onSaved: (i) => A.importFactsStep({ step: "saved", source: i.source, local: i.local, state: i.state, found: i.found, saved: i.saved, skipped: i.skipped }),
  });
  ipcMain.handle("importFacts:info", () => h.info());
  ipcMain.handle("importFacts:pick", async (_event, source: unknown) => {
    const win = deps.window();
    const chatgpt = source === "chatgpt";
    const opts = {
      title: chatgpt ? "Choose the .zip from ChatGPT's Export data" : "Choose the .zip from Claude's Export data",
      properties: (process.platform === "darwin" ? ["openFile", "openDirectory"] : ["openFile"]) as Array<"openFile" | "openDirectory">,
      filters: [{ name: chatgpt ? "ChatGPT data export" : "Claude data export", extensions: ["zip"] }],
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, path: picked.filePaths[0] };
  });
  ipcMain.handle("importFacts:start", (_event, input: unknown) => h.start(input));
  ipcMain.handle("importFacts:job", (_event, id: unknown) => h.job(id));
  ipcMain.handle("importFacts:stop", (_event, id: unknown) => h.stop(id));
  ipcMain.handle("importFacts:forget", (_event, id: unknown) => h.forget(id));
  ipcMain.handle("importFacts:save", (_event, id: unknown, ids: unknown) => h.save(id, ids));
}
