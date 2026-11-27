/**
 * ATO-2533 (review round 1): files the preview's Save never writes without a
 * person saying yes in a main-side dialog, wherever the chat folder is.
 *
 *   - any hidden entry (a path segment that starts with `.`), counted from
 *     the chat folder when the file is inside it and from the home folder
 *     otherwise: `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.gitconfig`,
 *     `~/.ssh/…`, `~/.aws/…`, `~/.config/…`, and in a project `.env` or
 *     `.git/hooks/…`;
 *   - the places a login runs things from: `~/Library/LaunchAgents/…` and the
 *     Windows Startup folder;
 *   - the agent's state folders, except a chat folder that is one of its
 *     worktrees (`<state>/worktrees/<repo>/<name>`), whose files are the
 *     project's own.
 *
 * Pure: no Electron import, so the unit suite loads it from `out/main`.
 */

import { isUnder, pathFor, type Platform } from "./platform.js";

/** Under home: folders whose files run at login. */
const LOGIN_RUN_DIRS: readonly (readonly string[])[] = [
  ["Library", "LaunchAgents"],
  ["AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup"],
];

export interface SensitiveSaveContext {
  platform: Platform;
  /** The home folder, real path. */
  home: string;
  /** The chat folder, real path, or null when there is none (or it is home or holds it). */
  folder: string | null;
  /** The agent's state folders, real paths. */
  stateDirs: readonly string[];
}

/** The path segments of `real` below `base` (which holds it). */
function segmentsBelow(platform: Platform, base: string, real: string): string[] {
  return real.slice(base.length).split(platform === "win32" ? /[\\/]/ : /\//).filter(Boolean);
}

/** Strictly inside `root`, not `root` itself. */
function strictlyUnder(platform: Platform, root: string, p: string): boolean {
  return isUnder(platform, root, p) && segmentsBelow(platform, root, p).length > 0;
}

/** Whether Save to `real` needs a person's yes even inside the chat folder. */
export function isSensitiveSavePath(real: string, c: SensitiveSaveContext): boolean {
  const { platform, home, folder } = c;
  const path = pathFor(platform);
  const inFolder = !!folder && isUnder(platform, folder, real);
  for (const dir of c.stateDirs) {
    if (!isUnder(platform, dir, real)) continue;
    const worktrees = path.join(dir, "worktrees");
    const projectWorktree = inFolder && !!folder && strictlyUnder(platform, worktrees, folder);
    if (!projectWorktree) return true;
  }
  const base = inFolder ? folder : isUnder(platform, home, real) ? home : null;
  if (base && segmentsBelow(platform, base, real).some((s) => s.startsWith("."))) return true;
  return LOGIN_RUN_DIRS.some((parts) => isUnder(platform, path.join(home, ...parts), real));
}

/** `~/…` for a path under home, the path itself otherwise. */
function shown(real: string, home: string, platform: Platform): string {
  if (!isUnder(platform, home, real) || real === home) return real;
  return `~${real.slice(home.length)}`;
}

/** The main-side question before Save writes a file outside the chat folder or a sensitive one. */
export function previewSaveConfirmDialog(real: string, sensitive: boolean, home: string, platform: Platform) {
  return {
    type: "warning" as const,
    message: sensitive ? "Save changes to a settings file?" : "Save changes to a file outside the chat folder?",
    detail: sensitive
      ? `${shown(real, home, platform)}\n\nThis is a hidden or startup file. Changing it can change how your shell, your apps or the agent run. Save only if you meant to edit this file.`
      : `${shown(real, home, platform)}\n\nSave writes without asking only inside the chat's folder. Allow saving this one file until the app quits?`,
    buttons: ["Save", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}
