import { join } from "node:path";
import { app, ipcMain, shell } from "electron";

import { pendingDraftsRoot } from "./show-once-draft.js";
import { readShowOnceOptions, writeShowOnceOptions, type ShowOnceOptions } from "./show-once-options.js";
import { readDraftSnapshots } from "./show-once-snapshots.js";

/**
 * ATO-2499 "Show once": the routes around a recording rather than the
 * recording itself (that is show-once-ipc.ts, which wires these):
 *
 *   showOnce:setOption (key, value)  → the card's switches, `tidy` / `snapshots`,
 *                                      saved in userData/show-once.json (show-once-options.ts)
 *   showOnce:draftSnapshots (id)     → `{ok, pictures:[{step, src}]}`: a draft's
 *                                      step pictures as data URLs, for To review
 *   showOnce:openAccessibility, showOnce:openScreenRecording → macOS's panes
 *
 * Drafts live on the computer that runs the agent: with a remote agent the
 * pictures route answers none.
 */

const DRAFT_ID_RE = /^[0-9a-f]{4,16}$/; // pending-drafts.ts PENDING_ID_PATTERN

type Deps = { stateDir: string; isRemote: () => boolean; log: (line: string) => void; changed: () => void };

export function wireShowOnceReviewIpc(deps: Deps): { options: () => ShowOnceOptions } {
  const dir = app.getPath("userData");
  let options = readShowOnceOptions(dir);

  ipcMain.handle("showOnce:setOption", async (_e, key: unknown, value: unknown) => {
    if ((key !== "tidy" && key !== "snapshots") || typeof value !== "boolean") return { ok: false };
    options = key === "tidy" ? { ...options, tidy: value } : { ...options, snapshots: value };
    await writeShowOnceOptions(dir, options).catch((err) => deps.log(`[desktop] show once: could not save the switches: ${String(err)}`));
    deps.changed();
    return { ok: true };
  });
  ipcMain.handle("showOnce:draftSnapshots", async (_e, id: unknown) => {
    if (typeof id !== "string" || !DRAFT_ID_RE.test(id) || deps.isRemote()) return { ok: true, pictures: [] };
    try {
      return { ok: true, pictures: await readDraftSnapshots(join(pendingDraftsRoot(deps.stateDir), id)) };
    } catch {
      return { ok: true, pictures: [] };
    }
  });
  ipcMain.handle("showOnce:openAccessibility", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility").then(() => true, () => false));
  ipcMain.handle("showOnce:openScreenRecording", () =>
    shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture").then(() => true, () => false));
  return { options: () => ({ ...options }) };
}
