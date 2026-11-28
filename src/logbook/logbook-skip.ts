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
 *
 * On Windows and Linux (ATO-2526) the id is the process name (Windows,
 * without `.exe`) or the window class (X11), lower case, and
 * `DESKTOP_PROTECTED_APPS` plays the part of the macOS bundle ids.
 */
export interface FrontApp {
  name: string | null;
  bundleId: string | null;
}

/**
 * Windows process names and X11 window classes never captured: password
 * managers, the lock screen and sign-in prompts (UAC, polkit, pinentry,
 * the keyring), system settings and Atomic Agent itself. An entry also
 * covers ids that continue with `-` (`pinentry-gtk-2`).
 */
export const DESKTOP_PROTECTED_APPS: readonly string[] = [
  // Atomic Agent itself.
  "atomic agent",
  "atomic-agent",
  "atomic-agent-desktop",
  // Password managers.
  "1password",
  "keepass",
  "keepassxc",
  "org.keepassxc.keepassxc",
  "bitwarden",
  "dashlane",
  "lastpass",
  "enpass",
  "nordpass",
  "proton pass",
  "protonpass",
  "roboform",
  "keeper",
  "keeperpasswordmanager",
  "seahorse",
  "kwalletmanager",
  "kwalletmanager5",
  // Lock screen, sign-in and permission prompts.
  "lockapp",
  "logonui",
  "consent",
  "credentialuibroker",
  "winlogon",
  "gcr-prompter",
  "polkit-gnome-authentication-agent-1",
  "polkit-kde-authentication-agent-1",
  "lxpolkit",
  "pinentry",
  "ssh-askpass",
  "ksshaskpass",
  "gnome-screensaver",
  "light-locker",
  "xscreensaver",
  "i3lock",
  "slock",
  "xsecurelock",
  // System settings.
  "systemsettings",
  "gnome-control-center",
];

function matchesBundle(list: readonly string[], lower: string): boolean {
  return list.some((id) => {
    const entry = id.toLowerCase();
    return lower === entry || lower.startsWith(`${entry}.`);
  });
}

function matchesDesktop(lower: string): boolean {
  return DESKTOP_PROTECTED_APPS.some((entry) => lower === entry || lower.startsWith(`${entry}-`));
}

/** Whether `app` is one of `list`: a bundle id (or a prefix of one), a process name, or the app's name. */
export function appListMatches(app: FrontApp | null | undefined, list: readonly string[]): boolean {
  const lower = app?.bundleId?.toLowerCase() ?? "";
  const name = app?.name?.trim().toLowerCase() ?? "";
  return list.some((raw) => {
    const item = raw.trim().toLowerCase().replace(/\.exe$/, "");
    if (!item) return false;
    return (lower.length > 0 && (item === lower || lower.startsWith(`${item}.`))) || (name.length > 0 && item === name);
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
  if (matchesDesktop(lower) || (name.length > 0 && matchesDesktop(name))) return `a protected app is in front (${app?.name ?? bundleId})`;
  if (appListMatches(app, excludeApps)) return `${app?.name ?? bundleId} is on your excluded list`;
  return null;
}
