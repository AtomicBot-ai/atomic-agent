/**
 * Studio's IPC routes (`studio:*`) and its push channel. The contract the
 * window codes against is renderer/studio/CONTRACT.md; keep both in step.
 *
 * Every route answers `{ok: true, data}` or `{ok: false, error: {code,
 * message, details?}}` (studio-errors.ts) and never throws at the window.
 * Job changes are pushed on `studio:job` with one `StudioJob`.
 *
 * Files: the window names a path only for files Studio made (inside its
 * output folders) or ones this process's own dialog returned
 * (studio-paths.ts). Output folders are changed only to a folder the
 * folder dialog returned, or back to the default.
 */

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

import { imageDataUrl } from "./image-data-url.js";
import type { StudioKind } from "./studio-catalog.js";
import { StudioCoreError } from "./studio-core-client.js";
import { studioErrorBody } from "./studio-errors.js";
import { StudioMedia, type StudioMediaDeps } from "./studio-media.js";
import { insideRoots, realPathOf } from "./studio-paths.js";
import { StudioPricing, type StudioPriceParams } from "./studio-pricing.js";

const kindOf = (v: unknown): StudioKind | null => (v === "image" || v === "video" ? v : null);
const idOf = (v: unknown): string | null => (typeof v === "string" && /^[\w.:-]{1,128}$/.test(v) ? v : null);

type Answer = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: string } };

async function answer(fn: () => Promise<unknown>, cloud = false): Promise<Answer> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: studioErrorBody(err, cloud) };
  }
}

const bad = (message: string): Answer => ({ ok: false, error: { code: "INVALID_REQUEST", message } });
const isCloud = (req: unknown): boolean => (req as { provider?: unknown } | null)?.provider !== "local";

export function wireStudioIpc(opts: Omit<StudioMediaDeps, "emitJob"> & { window: () => BrowserWindow | null }): StudioMedia {
  const studio = new StudioMedia({
    ...opts,
    emitJob: (job) => {
      const w = opts.window();
      if (w && !w.isDestroyed()) w.webContents.send("studio:job", job);
    },
  });
  const pricing = new StudioPricing(opts.request ?? fetch);
  /** Folders the folder dialog returned this session: the only ones setOutputDir takes. */
  const chosenDirs = new Set<string>();

  ipcMain.handle("studio:catalog", (_e, kind: unknown) => {
    const k = kindOf(kind);
    return k ? answer(() => studio.catalog(k)) : bad("kind must be 'image' or 'video'");
  });
  ipcMain.handle("studio:generateImage", (_e, req: unknown) => answer(() => studio.generate("image", req), isCloud(req)));
  ipcMain.handle("studio:generateVideo", (_e, req: unknown) => answer(() => studio.generate("video", req), isCloud(req)));
  ipcMain.handle("studio:estimateVideo", (_e, req: unknown) => answer(() => studio.estimateVideo(req)));
  ipcMain.handle("studio:job", (_e, kind: unknown, id: unknown) => {
    const k = kindOf(kind), i = idOf(id);
    return k && i ? answer(() => studio.job(k, i)) : bad("kind and job id are required");
  });
  ipcMain.handle("studio:activeJobs", () => answer(async () => studio.jobs.list()));
  ipcMain.handle("studio:cancel", (_e, kind: unknown, id: unknown) => {
    const k = kindOf(kind), i = idOf(id);
    return k && i ? answer(() => studio.cancel(k, i)) : bad("kind and job id are required");
  });
  ipcMain.handle("studio:gallery", (_e, kind: unknown, o: unknown) => {
    const k = kindOf(kind);
    const opt = (o && typeof o === "object" ? o : {}) as { offset?: number; limit?: number; includeArchived?: boolean };
    return k ? answer(() => studio.gallery(k, opt)) : bad("kind must be 'image' or 'video'");
  });
  ipcMain.handle("studio:galleryDelete", (_e, kind: unknown, ids: unknown) => {
    const k = kindOf(kind);
    const list = Array.isArray(ids) ? ids.map(idOf) : [];
    if (!k || !list.length || list.some((i) => i === null) || list.length > 500) return bad("kind and a list of item ids are required");
    return answer(async () => { await studio.galleryDelete(k, list as string[]); return { deleted: list.length }; });
  });
  ipcMain.handle("studio:pin", (_e, kind: unknown, id: unknown, on: unknown) => {
    const k = kindOf(kind), i = idOf(id);
    return k && i ? answer(() => studio.pin(k, i, on === true)) : bad("kind and item id are required");
  });
  ipcMain.handle("studio:outputDir", (_e, kind: unknown) => {
    const k = kindOf(kind);
    return k ? answer(() => studio.outputDir(k)) : bad("kind must be 'image' or 'video'");
  });
  ipcMain.handle("studio:chooseOutputDir", (event, kind: unknown) => {
    const k = kindOf(kind);
    if (!k) return bad("kind must be 'image' or 'video'");
    return answer(async () => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? opts.window();
      const dialogOpts = { properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">, title: k === "video" ? "Folder for videos" : "Folder for images" };
      const picked = owner ? await dialog.showOpenDialog(owner, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
      if (picked.canceled || !picked.filePaths[0]) return null;
      chosenDirs.add(picked.filePaths[0]);
      return studio.setOutputDir(k, picked.filePaths[0]);
    });
  });
  ipcMain.handle("studio:setOutputDir", (_e, kind: unknown, path: unknown) => {
    const k = kindOf(kind);
    if (!k) return bad("kind must be 'image' or 'video'");
    if (path !== null && path !== "" && !(typeof path === "string" && chosenDirs.has(path))) {
      return bad("Choose the folder with chooseOutputDir, or pass null for the default.");
    }
    return answer(() => studio.setOutputDir(k, typeof path === "string" && path ? path : null));
  });
  ipcMain.handle("studio:price", (_e, modelId: unknown, params: unknown) => {
    const p = (params && typeof params === "object" ? params : {}) as StudioPriceParams;
    if (typeof modelId !== "string" || (p.kind !== "image" && p.kind !== "video")) return bad("modelId and params.kind are required");
    return answer(() => pricing.price(modelId, p));
  });
  ipcMain.handle("studio:pickImages", (event, multiple: unknown) => answer(async () => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? opts.window();
    const dialogOpts = {
      properties: (multiple === true ? ["openFile", "multiSelections"] : ["openFile"]) as Array<"openFile" | "multiSelections">,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    };
    const picked = owner ? await dialog.showOpenDialog(owner, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    if (picked.canceled) return [];
    return picked.filePaths.slice(0, 16).map((p) => { studio.picked.add(p); return { path: p, name: basename(p) }; });
  }));
  ipcMain.handle("studio:preview", (_e, path: unknown) => answer(async () => {
    const real = insideRoots(path, studio.roots()) ?? (studio.picked.has(path) ? realPathOf(path) : null);
    if (!real) return { ok: false, reason: "outside" };
    return imageDataUrl(real, [...studio.roots(), real], homedir(), process.platform);
  }));
  ipcMain.handle("studio:reveal", (_e, path: unknown) => answer(async () => {
    const real = insideRoots(path, studio.roots());
    if (!real) throw new StudioCoreError("Only a file Studio made can be shown.", "OUTSIDE");
    shell.showItemInFolder(real);
    return { revealed: true };
  }));
  ipcMain.handle("studio:saveAs", (event, path: unknown) => answer(async () => {
    const real = insideRoots(path, studio.roots());
    if (!real) throw new StudioCoreError("Only a file Studio made can be saved elsewhere.", "OUTSIDE");
    const owner = BrowserWindow.fromWebContents(event.sender) ?? opts.window();
    const dialogOpts = { defaultPath: basename(real) };
    const picked = owner ? await dialog.showSaveDialog(owner, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
    if (picked.canceled || !picked.filePath) return { saved: false };
    await copyFile(real, picked.filePath);
    return { saved: true, path: picked.filePath };
  }));
  return studio;
}
