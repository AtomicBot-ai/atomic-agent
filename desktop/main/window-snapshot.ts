/**
 * ATO-532 — a snapshot of another app's window, attached to the chat.
 *
 * The pure half: which of the windows the system lists are offered, how big
 * the attached picture is, and what the file is called. The Electron half
 * (desktopCapturer, the macOS permission, the IPC routes) is in
 * window-snapshot-ipc.ts.
 *
 * View-only: a window is looked at, never clicked or typed into.
 */

/** One window as desktopCapturer lists it, reduced to what the filter reads. */
export interface SnapshotSourceLike {
  id: string;
  name: string;
  /** True when the system gave no picture for it (a minimized or off-screen window on some systems). */
  thumbEmpty?: boolean;
}

/** The long side of a picker tile's picture, in pixels (a 2x tile of ~160 px). */
export const PICKER_THUMB_PX = 320;
/** The long side of the attached snapshot, in pixels. */
export const SNAPSHOT_MAX_PX = 1920;
/** Over this a PNG snapshot is sent as JPEG instead (the composer's image cap is 10 MB). */
export const SNAPSHOT_PNG_MAX_BYTES = 6 * 1024 * 1024;
/** At most this many windows are offered. */
export const PICKER_MAX = 60;

/**
 * The numeric part of a window source id. desktopCapturer names a window
 * `window:<native id>:<n>`, and `BrowserWindow.getMediaSourceId()` names our
 * own windows the same way; the trailing part has differed between Chromium
 * versions, so only the native id is compared.
 */
export function nativeWindowId(id: string): string | null {
  const m = /^window:(\d+)(?::|$)/.exec(String(id ?? ""));
  return m ? m[1] : null;
}

/**
 * The windows the picker offers, in the order the system gave them (on
 * macOS and Windows the front-most first): never one of this app's own
 * windows, never one without a title or a picture, each id once, at most
 * PICKER_MAX.
 */
export function pickerSources<T extends SnapshotSourceLike>(sources: readonly T[], ownIds: readonly string[]): T[] {
  const own = new Set(ownIds.map(nativeWindowId).filter((x): x is string => x !== null));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of sources ?? []) {
    if (!s || typeof s.id !== "string" || !s.id.startsWith("window:")) continue;
    const nid = nativeWindowId(s.id);
    if (nid !== null && own.has(nid)) continue;
    if (seen.has(s.id)) continue;
    if (typeof s.name !== "string" || s.name.trim() === "") continue;
    if (s.thumbEmpty) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= PICKER_MAX) break;
  }
  return out;
}

/**
 * A size scaled down so its long side is at most `max`, keeping the aspect
 * ratio; never scaled up. Whole pixels, at least 1x1.
 */
export function fitLongSide(width: number, height: number, max: number): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 0;
  const h = Number.isFinite(height) && height > 0 ? height : 0;
  if (!w || !h) return { width: 0, height: 0 };
  const longest = Math.max(w, h);
  if (longest <= max) return { width: Math.round(w), height: Math.round(h) };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * The attachment's file name: `window-<title>.png` (or `.jpg`), the title
 * cut to plain letters, digits and dashes and to 48 characters. Main's
 * saveAttachment sanitizes it again and stamps the time in front.
 */
export function snapshotFileName(title: string, ext: "png" | "jpg" = "png"): string {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
    .toLowerCase();
  return `window${slug ? "-" + slug : ""}.${ext}`;
}

/** What the picker says when macOS has not allowed screen capture. */
export const SCREEN_PERMISSION_MESSAGE =
  "To attach a window, allow Atomic Agent to record the screen: System Settings → Privacy & Security → Screen & System Audio Recording, turn on Atomic Agent, then quit and reopen the app.";

/**
 * Whether the picker may list windows, from the platform and macOS's
 * screen-capture status. Only macOS asks; elsewhere the answer is yes.
 */
export function screenAccessVerdict(platform: string, status: string | null): "ok" | "permission" {
  if (platform !== "darwin") return "ok";
  return status === "granted" ? "ok" : "permission";
}
