/**
 * ATO-2744 — `privacy:open`: opens one named pane of macOS System Settings
 * › Privacy & Security, for a panel that just told the person a permission
 * is missing (My files: a file the index may not read; Show once: a
 * recording that heard nothing).
 *
 *   privacy:open(pane) → { ok: true } | { ok: false, error }
 *
 * Only the panes below, and only on macOS: the renderer names a pane, never
 * a URL, so nothing else can be opened through this route. Windows and
 * Linux have no such pane and are refused in words.
 *
 * No Electron import: show-once-ipc.ts passes ipcMain and shell in, so the
 * unit tests (test/privacy-pane.test.mjs) drive it as plain Node.
 */

export const PRIVACY_PANES = {
  /** Full Disk Access: what lets the agent index files outside the usual folders. */
  fullDiskAccess: "Privacy_AllFiles",
  /** Input Monitoring: what lets Show once hear clicks and keys in other apps. */
  inputMonitoring: "Privacy_ListenEvent",
} as const;

export type PrivacyPane = keyof typeof PRIVACY_PANES;

const BASE = "x-apple.systempreferences:com.apple.preference.security?";

/** The settings URL for a whitelisted pane on macOS, else null. */
export function privacyPaneUrl(pane: unknown, platform: NodeJS.Platform): string | null {
  if (platform !== "darwin") return null;
  if (typeof pane !== "string" || !Object.prototype.hasOwnProperty.call(PRIVACY_PANES, pane)) return null;
  return BASE + PRIVACY_PANES[pane as PrivacyPane];
}

export interface PrivacyPaneDeps {
  openExternal: (url: string) => Promise<unknown>;
  platform: NodeJS.Platform;
}

export async function openPrivacyPane(deps: PrivacyPaneDeps, pane: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (deps.platform !== "darwin") return { ok: false, error: "These settings are on macOS only." };
  const url = privacyPaneUrl(pane, deps.platform);
  if (!url) return { ok: false, error: "That settings pane can't be opened from here." };
  try {
    await deps.openExternal(url);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't open System Settings. Open Privacy & Security there yourself." };
  }
}

export function registerPrivacyPaneIpc(deps: PrivacyPaneDeps & {
  ipcMain: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void };
}): void {
  deps.ipcMain.handle("privacy:open", (_event, pane) => openPrivacyPane(deps, pane));
}
