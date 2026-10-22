import type { DesktopSharing } from "./detect-desktop-sharing.js";

/**
 * The wording the CLI plan and the TUI confirm screen both show about
 * the desktop app. Kept here, once, so the two surfaces cannot drift.
 * No em dashes in user-facing text.
 */
export const DESKTOP_SHARED_WARNING =
  "The Atomic Agent desktop app uses this same folder. Its chats, memory, settings, API keys and models will be deleted too.";

/** The "not removed" line for a desktop directory from before 0.0.3. */
export function legacyDesktopDirNotice(dir: string): string {
  return `Left in place: ${dir} (data from an older desktop app). Delete it yourself if you no longer need it.`;
}

/**
 * Whether the shared-folder warning belongs under `targetPath`: the row
 * is the state directory, and a current desktop app uses it. Under
 * `--keep-data` the state directory is not in the plan, so there is no
 * row to warn under and nothing of the desktop's is deleted.
 */
export function desktopWarningApplies(
  desktop: DesktopSharing,
  targetPath: string,
): boolean {
  return desktop.sharesStateDir && targetPath === desktop.stateDir;
}
