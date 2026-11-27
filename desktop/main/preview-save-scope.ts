/**
 * ATO-2533: where Save from the preview panel may write.
 *
 * The preview reads from wide roots (the whole home folder, the agent's state
 * and temp folders, the working folder: file-preview.ts previewRootsFor), but
 * Save writes only to
 *
 *   - a file inside the chat's working folder, links resolved (a link in the
 *     folder that leads out of it is outside it), or
 *   - the very file main served to the panel while that folder was the chat's
 *     folder: the same real path and the same file (dev/inode), so a link or
 *     another file put in its place later is refused.
 *
 * Anything else is `outside`. main also takes Save only from the main
 * window's own page (main.ts), not from a frame or another window.
 *
 * Review round 1: the renderer asks main to preview a file, so "opened" alone
 * is the renderer's own say. Two things now need a person, asked in a
 * main-side dialog (`confirm`), once per file until the app quits:
 *
 *   - any file outside the chat folder, even one the panel opened;
 *   - a sensitive file (preview-save-sensitive.ts: hidden entries such as
 *     `~/.zshrc` or `.ssh/`, login-run folders, the agent's state), even
 *     inside the chat folder.
 *
 * A chat folder that is the home folder or holds it (a fresh install, where
 * the folder is home) counts as no folder: then every Save asks.
 *
 * Pure but for the file system: no Electron import, so the unit suite loads it
 * from `out/main`.
 */

import { realpath, stat } from "node:fs/promises";

import { isUnder, type Platform } from "./platform.js";
import { isSensitiveSavePath } from "./preview-save-sensitive.js";

/** How many files the panel opened are remembered; the oldest goes first. */
export const PREVIEW_OPENED_MAX = 64;

type Opened = { dev: number; ino: number; workingDir: string | null; confirmed: boolean };

/** The real files main served to the preview panel, each with the working folder it was opened under. */
export class PreviewOpenedFiles {
  private readonly files = new Map<string, Opened>();

  /** Remember `real` (a path filePreview resolved) as opened under `workingDir`. */
  async remember(real: string, workingDir: string | null | undefined): Promise<void> {
    const st = await stat(real).catch(() => null);
    if (!st || !st.isFile()) return;
    const wd = workingDir || null;
    const prev = this.files.get(real);
    // Opening the same file again keeps a yes already given for it.
    const confirmed = !!prev && prev.confirmed && prev.dev === st.dev && prev.ino === st.ino && prev.workingDir === wd;
    this.files.delete(real);
    this.files.set(real, { dev: st.dev, ino: st.ino, workingDir: wd, confirmed });
    while (this.files.size > PREVIEW_OPENED_MAX) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
  }

  /** The real paths opened under `workingDir`: extra roots for the save's path check. */
  paths(workingDir: string | null | undefined): string[] {
    const wd = workingDir || null;
    return [...this.files].filter(([, o]) => o.workingDir === wd).map(([p]) => p);
  }

  /** Whether `real` is that very file, opened under `workingDir`. */
  has(real: string, dev: number, ino: number, workingDir: string | null | undefined): boolean {
    const o = this.files.get(real);
    return !!o && o.dev === dev && o.ino === ino && o.workingDir === (workingDir || null);
  }

  /** Whether a person already said yes to saving that very file. */
  confirmed(real: string, dev: number, ino: number, workingDir: string | null | undefined): boolean {
    const o = this.files.get(real);
    return !!o && o.confirmed && this.has(real, dev, ino, workingDir);
  }

  /** A person said yes to saving that very file (main's dialog). */
  confirm(real: string, dev: number, ino: number, workingDir: string | null | undefined): void {
    const o = this.files.get(real);
    if (o && this.has(real, dev, ino, workingDir)) o.confirmed = true;
  }
}

/** What the save scope needs besides the folder: home, the agent's state folders and main's dialog. */
export interface PreviewSaveGuard {
  home: string;
  stateDirs: readonly string[];
  /** Ask the person in main (never the renderer); true only for a yes. */
  confirm: (real: string, sensitive: boolean) => Promise<boolean>;
}

/** Where Save may write now: the roots for the path check and the final say on the checked file. */
export interface PreviewSaveScope {
  roots: string[];
  allows: (t: { real: string; dev: number; ino: number }) => Promise<boolean>;
}

/** The save scope for the chat's working folder (null for a remote agent: then only opened files). */
export function previewSaveScope(
  workingDir: string | null | undefined,
  opened: PreviewOpenedFiles,
  platform: Platform,
  guard: PreviewSaveGuard,
): PreviewSaveScope {
  const wd = workingDir || null;
  return {
    roots: [...(wd ? [wd] : []), ...opened.paths(wd)],
    allows: async (t) => {
      const real = (p: string): Promise<string> => realpath(p).catch(() => p);
      const home = await real(guard.home);
      const realWd = wd ? await realpath(wd).catch(() => null) : null;
      // Home or a folder above it is no folder: a fresh install's folder is home.
      const folder = realWd && !isUnder(platform, realWd, home) ? realWd : null;
      const stateDirs = await Promise.all(guard.stateDirs.map(real));
      const sensitive = isSensitiveSavePath(t.real, { platform, home, folder, stateDirs });
      if (folder && !sensitive && isUnder(platform, folder, t.real)) return true;
      if (!opened.has(t.real, t.dev, t.ino, wd)) return false;
      if (opened.confirmed(t.real, t.dev, t.ino, wd)) return true;
      const yes = (await guard.confirm(t.real, sensitive).catch(() => false)) === true;
      if (yes) opened.confirm(t.real, t.dev, t.ino, wd);
      return yes;
    },
  };
}
