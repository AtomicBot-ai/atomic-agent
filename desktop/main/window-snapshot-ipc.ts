/**
 * ATO-532 — the window picker's routes (renderer/window-snapshot.js).
 *
 *   snapshot:windows   the open windows of other apps, each with a small
 *                      picture and the app's icon, or why there are none
 *                      (macOS has not allowed screen capture)
 *   snapshot:capture   one of those windows, larger (long side up to
 *                      SNAPSHOT_MAX_PX), as PNG bytes (JPEG when the PNG is
 *                      big) for the composer to attach like a pasted image
 *
 * View-only: desktopCapturer reads pixels; nothing is ever clicked, typed or
 * sent to another window. The window can only ask for an id the last
 * listing returned, so it cannot name an arbitrary source.
 */

import { BrowserWindow, desktopCapturer, ipcMain, systemPreferences, type DesktopCapturerSource } from "electron";

import {
  PICKER_THUMB_PX,
  SCREEN_PERMISSION_MESSAGE,
  SNAPSHOT_MAX_PX,
  SNAPSHOT_PNG_MAX_BYTES,
  fitLongSide,
  pickerSources,
  screenAccessVerdict,
  snapshotFileName,
} from "./window-snapshot.js";

type ListAnswer =
  | { ok: true; windows: Array<{ id: string; name: string; thumb: string; icon: string | null }> }
  | { ok: false; reason: "permission" | "failed"; error: string };

type CaptureAnswer =
  | { ok: true; bytes: Uint8Array; name: string; mimeType: "image/png" | "image/jpeg"; width: number; height: number }
  | { ok: false; reason: "gone" | "permission" | "failed"; error: string };

function screenStatus(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return null;
  }
}

/** Our own windows' source ids (the main window, the remote-connect window, any other). */
function ownSourceIds(): string[] {
  const out: string[] = [];
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) out.push(w.getMediaSourceId());
    } catch { /* a window going away */ }
  }
  return out;
}

export function wireWindowSnapshotIpc(): void {
  const listed = new Map<string, string>();   // source id → its title, from the last listing only (at most PICKER_MAX)

  ipcMain.handle("snapshot:windows", async (): Promise<ListAnswer> => {
    const status = screenStatus();
    if (screenAccessVerdict(process.platform, status) === "permission") {
      /* Never asked yet: one listing makes macOS show its prompt and puts the
         app in the Screen Recording list, so the switch the message names is
         there to turn on. Its answer is not used. */
      if (status === "not-determined") {
        try { await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1, height: 1 } }); } catch { /* the message says what to do */ }
      }
      return { ok: false, reason: "permission", error: SCREEN_PERMISSION_MESSAGE };
    }
    let sources: DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: PICKER_THUMB_PX, height: PICKER_THUMB_PX },
        fetchWindowIcons: true,
      });
    } catch {
      return { ok: false, reason: "failed", error: "The list of windows could not be read." };
    }
    const offered = pickerSources(
      sources.map((s) => ({ id: s.id, name: s.name, thumbEmpty: !s.thumbnail || s.thumbnail.isEmpty(), src: s })),
      ownSourceIds(),
    );
    listed.clear();
    const windows = offered.map(({ src }) => {
      listed.set(src.id, src.name);
      const icon = src.appIcon && !src.appIcon.isEmpty() ? src.appIcon.resize({ width: 32, height: 32 }).toDataURL() : null;
      return { id: src.id, name: src.name, thumb: src.thumbnail.toDataURL(), icon };
    });
    return { ok: true, windows };
  });

  ipcMain.handle("snapshot:capture", async (_event, id: unknown): Promise<CaptureAnswer> => {
    if (typeof id !== "string" || !listed.has(id)) return { ok: false, reason: "gone", error: "That window is no longer in the list." };
    if (screenAccessVerdict(process.platform, screenStatus()) === "permission") {
      return { ok: false, reason: "permission", error: SCREEN_PERMISSION_MESSAGE };
    }
    let sources: DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: SNAPSHOT_MAX_PX, height: SNAPSHOT_MAX_PX },
        fetchWindowIcons: false,
      });
    } catch {
      return { ok: false, reason: "failed", error: "The window could not be captured." };
    }
    const src = sources.find((s) => s.id === id);
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
      return { ok: false, reason: "gone", error: "That window was closed or minimized." };
    }
    let image = src.thumbnail;
    const size = image.getSize();
    const fit = fitLongSide(size.width, size.height, SNAPSHOT_MAX_PX);
    if (fit.width && (fit.width !== size.width || fit.height !== size.height)) {
      image = image.resize({ width: fit.width, height: fit.height, quality: "best" });
    }
    const title = src.name || listed.get(id) || "";
    const png = image.toPNG();
    const useJpeg = png.byteLength > SNAPSHOT_PNG_MAX_BYTES;
    const bytes = useJpeg ? image.toJPEG(90) : png;
    const out = image.getSize();
    return {
      ok: true,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      name: snapshotFileName(title, useJpeg ? "jpg" : "png"),
      mimeType: useJpeg ? "image/jpeg" : "image/png",
      width: out.width,
      height: out.height,
    };
  });
}
