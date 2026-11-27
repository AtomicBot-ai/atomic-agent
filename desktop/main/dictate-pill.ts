import { BrowserWindow, globalShortcut, Notification, screen, session } from "electron";
import { join } from "node:path";

import { dictatePillBounds } from "./dictate-anywhere.js";
import { DICTATE_FAILURE_MS, DICTATE_FAILURE_PILL_SIZE, type DictateFailureView } from "./dictate-errors.js";
import { quickEntryWindowLevel } from "./quick-entry.js";

/**
 * The dictation pill's window (ATO-1064), moved out of
 * dictate-anywhere-window.ts with ATO-2750's failure mode.
 *
 * The pill holds the microphone for a take, in its own session partition
 * whose permission handlers allow audio only while the take is armed. It
 * never takes the keyboard (not focusable, shown inactive), so the app in
 * front stays in front and gets the paste.
 *
 * ATO-2750: the same pill shows a failure line (dictate-errors.ts) with its
 * settings button, wider, without Esc and without the microphone; it goes
 * on its own after DICTATE_FAILURE_MS. The system notification is only for
 * when the pill cannot be made.
 */

const PARTITION = "dictate-anywhere";

const pills = new WeakSet<BrowserWindow>();

/** True for the dictation pill: not "a window of the app" for the Dock reopen. */
export function isDictatePill(win: BrowserWindow): boolean {
  return pills.has(win);
}

export function notifyDictation(body: string): void {
  try { if (Notification.isSupported()) new Notification({ title: "Dictation", body, silent: true }).show(); } catch { /* no notifications */ }
}

export interface DictatePillHooks {
  platform: NodeJS.Platform;
  /** Whether the take is armed: the only time the pill may have the microphone. */
  armed: () => boolean;
  /** The pill was closed from outside (or Esc during a take). */
  onCancel: () => void;
}

export class DictatePill {
  private win: BrowserWindow | null = null;
  private escHeld = false;
  private failTimer: NodeJS.Timeout | null = null;
  /** The failure the pill shows, or null during a take. */
  failure: DictateFailureView | null = null;

  constructor(private readonly h: DictatePillHooks) {
    const part = session.fromPartition(PARTITION);
    const allowed = (wc: Electron.WebContents | null, permission: string, types: string[] | undefined) =>
      permission === "media" && h.armed() && this.isPage(wc)
        && !!types && types.length > 0 && types.every((t) => t === "audio");
    part.setPermissionRequestHandler((wc, permission, callback, details) =>
      callback(allowed(wc, permission, (details as unknown as { mediaTypes?: string[] }).mediaTypes)));
    part.setPermissionCheckHandler((wc, permission, _origin, details) =>
      allowed(wc, permission, (details as unknown as { mediaTypes?: string[] }).mediaTypes));
  }

  get open(): boolean {
    return !!this.win && !this.win.isDestroyed();
  }

  /** True when `wc` is the pill's page. */
  isPage(wc: Electron.WebContents | null): boolean {
    return !!this.win && !this.win.isDestroyed() && wc === this.win.webContents;
  }

  send(payload: Record<string, unknown>): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("app:dictate", payload);
  }

  close(): void {
    if (this.escHeld) {
      this.escHeld = false;
      try { globalShortcut.unregister("Escape"); } catch { /* already gone */ }
    }
    if (this.failTimer) { clearTimeout(this.failTimer); this.failTimer = null; }
    this.failure = null;
    const p = this.win;
    this.win = null;
    if (p && !p.isDestroyed()) p.destroy();
  }

  /** The pill for a take, or (`forFailure`) for a failure line; false when it could not be made. */
  show(forFailure = false): boolean {
    const cursor = screen.getCursorScreenPoint();
    const displays = screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea }));
    const bounds = forFailure ? dictatePillBounds(cursor, displays, DICTATE_FAILURE_PILL_SIZE) : dictatePillBounds(cursor, displays);
    let win: BrowserWindow;
    try {
      win = new BrowserWindow({
        ...bounds,
        show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, hasShadow: true,
        backgroundColor: "#191C21", title: "Dictation",
        ...(this.h.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: join(__dirname, "..", "preload", "preload.js"),
          partition: PARTITION,
          contextIsolation: true, nodeIntegration: false, sandbox: true,
          autoplayPolicy: "no-user-gesture-required",
        },
      });
    } catch {
      return false;
    }
    this.win = win;
    pills.add(win);
    win.setAlwaysOnTop(true, quickEntryWindowLevel(this.h.platform));
    if (this.h.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => { if (this.win === win) this.h.onCancel(); });
    win.once("ready-to-show", () => { if (!win.isDestroyed()) win.showInactive(); });
    void win.loadFile(join(__dirname, "..", "renderer", "dictate-anywhere.html")).catch(() => {});
    // Esc throws the take away, as long as nothing else of ours holds it (the marks overlay).
    if (!forFailure && !globalShortcut.isRegistered("Escape")) {
      try { this.escHeld = globalShortcut.register("Escape", this.h.onCancel); } catch { this.escHeld = false; }
    }
    return true;
  }

  /** ATO-2750: a failure in the pill; a notification only when the pill cannot show. */
  showFailure(view: DictateFailureView): void {
    this.close();
    this.failure = view;
    if (!this.show(true)) { this.failure = null; notifyDictation(view.line); return; }
    this.failTimer = setTimeout(() => this.close(), DICTATE_FAILURE_MS);
  }
}
