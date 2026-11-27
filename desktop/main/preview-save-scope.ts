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
 * Pure but for the file system: no Electron import, so the unit suite loads it
 * from `out/main`.
 */

import { realpath, stat } from "node:fs/promises";

import { isUnder, type Platform } from "./platform.js";

/** How many files the panel opened are remembered; the oldest goes first. */
export const PREVIEW_OPENED_MAX = 64;

type Opened = { dev: number; ino: number; workingDir: string | null };

/** The real files main served to the preview panel, each with the working folder it was opened under. */
export class PreviewOpenedFiles {
  private readonly files = new Map<string, Opened>();

  /** Remember `real` (a path filePreview resolved) as opened under `workingDir`. */
  async remember(real: string, workingDir: string | null | undefined): Promise<void> {
    const st = await stat(real).catch(() => null);
    if (!st || !st.isFile()) return;
    this.files.delete(real);
    this.files.set(real, { dev: st.dev, ino: st.ino, workingDir: workingDir || null });
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
): PreviewSaveScope {
  const wd = workingDir || null;
  return {
    roots: [...(wd ? [wd] : []), ...opened.paths(wd)],
    allows: async (t) => {
      const realWd = wd ? await realpath(wd).catch(() => null) : null;
      if (realWd && isUnder(platform, realWd, t.real)) return true;
      return opened.has(t.real, t.dev, t.ino, wd);
    },
  };
}
