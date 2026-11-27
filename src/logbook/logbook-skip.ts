import { BLOCKED_BUNDLE_IDS } from "../tools/os/screen/screen-protected.js";
import { windowCaptureRefusal } from "../tools/os/screen/screen-window.js";

/**
 * Which front apps the logbook never photographs. It reuses the screen
 * tools' lists (`screen-protected.ts`, `screen-window.ts`): password
 * managers, the login and security prompts (a locked screen is
 * `loginwindow`), system settings, Atomic Agent itself and the script
 * runners. Browsers and terminals are photographed like any other app,
 * since a work day happens there; the person can add more apps to
 * `excludeApps`. An app the probe cannot name is skipped too: the
 * check cannot vouch for what it cannot see.
 */
export interface FrontApp {
  name: string | null;
  bundleId: string | null;
}

function matchesBundle(list: readonly string[], lower: string): boolean {
  return list.some((id) => {
    const entry = id.toLowerCase();
    return lower === entry || lower.startsWith(`${entry}.`);
  });
}

/** Why this front app is not captured, or `null` when it may be. */
export function logbookSkipReason(app: FrontApp | null | undefined, excludeApps: readonly string[]): string | null {
  const bundleId = app?.bundleId ?? null;
  if (!bundleId) return "the app in front could not be identified";
  if (windowCaptureRefusal(bundleId) !== null) return `a password or login window is in front (${bundleId})`;
  const lower = bundleId.toLowerCase();
  if (matchesBundle(BLOCKED_BUNDLE_IDS, lower)) return `a protected app is in front (${bundleId})`;
  const name = app?.name?.trim().toLowerCase() ?? "";
  const excluded = excludeApps.some((raw) => {
    const item = raw.trim().toLowerCase();
    if (!item) return false;
    return item === lower || lower.startsWith(`${item}.`) || (name.length > 0 && item === name);
  });
  if (excluded) return `${app?.name ?? bundleId} is on your excluded list`;
  return null;
}
