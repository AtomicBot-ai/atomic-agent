/**
 * ATO-2457: "Save as PNG" on an artifact or widget card in the chat.
 *
 * The window sends the frame's box as the page lays it out (CSS pixels,
 * after scrolling it into view); main grabs that part of the window
 * (`webContents.capturePage`, which works in DIP: CSS pixels times the
 * window's zoom), asks where to save (Downloads by default) and writes the
 * PNG. It saves what is on screen: a card taller than the window is cut at
 * the window's edge, as a screenshot would be.
 *
 * The frame's page is never asked for anything: the capture is of the app
 * window, so a sandboxed page cannot block, alter or read it.
 * Precedents: Claude artifacts' download, OpenClaw's canvas snapshot.
 *
 * Pure: no Electron import, so the unit suite loads it from `out/main`.
 */

export interface PngRect { x: number; y: number; width: number; height: number }

/** The largest side captured, in DIP; a larger box is cut to it. */
export const PNG_MAX_SIDE = 8192;

/**
 * The capture rect for a box the window sent, clipped to the window's
 * content (`view`, DIP) and scaled by its zoom. Null when the box is not a
 * real rectangle or lies outside the window.
 */
export function pngCaptureRect(raw: unknown, zoom: number, view: { width: number; height: number }): PngRect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const x0 = n(r.x) * z, y0 = n(r.y) * z, w = n(r.width) * z, h = n(r.height) * z;
  if (![x0, y0, w, h].every(Number.isFinite) || w < 1 || h < 1) return null;
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(view.width, Math.ceil(x0 + w), left + PNG_MAX_SIDE);
  const bottom = Math.min(view.height, Math.ceil(y0 + h), top + PNG_MAX_SIDE);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `quarterly-revenue.png` from "Quarterly revenue (2026)": a file name safe on every system. */
export function pngFileName(title: unknown): string {
  const slug = String(typeof title === "string" ? title : "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return (slug || "widget") + ".png";
}

/** The saved path with a .png ending, whatever the person typed. */
export function pngTarget(path: string): string {
  return /\.png$/i.test(path) ? path : path + ".png";
}
