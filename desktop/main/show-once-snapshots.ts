import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ShowOnceRect } from "./show-once-log.js";

/**
 * ATO-2499 "Show once": an optional picture of the window after each step,
 * for the person to look at while reviewing the draft. Off until they turn
 * it on on the Record card; never of a browser or a protected app (the
 * caller only asks for steps in other apps, show-once-ipc.ts).
 *
 * Kept on this Mac only: taken into `<stateDir>/show-once-shots/<run>/`
 * while recording, moved into the draft as `snapshots/step-<n>.jpg` when it
 * is saved (n is the step's number in the SKILL.md), and gone with the
 * draft folder when the draft is approved or discarded (the agent removes
 * the folder: pending-drafts.ts removePendingDraft). Never sent to a model.
 *
 * Taken with macOS's own `screencapture` (Screen Recording permission for
 * the app) of the window by its CGWindowID only, then shrunk with `sips` so
 * a recording stays small. Never of a screen rectangle: by the time the
 * picture is taken another app (a browser, a password manager, a system
 * prompt) can be on top of that frame. No window id (the osascript path,
 * without the helper) means no picture.
 */

export const SHOW_ONCE_SNAPSHOT_LIMITS = {
  /** Pictures in one recording. */
  maxPictures: 100,
  /** The longest side of a picture, in pixels. */
  maxSide: 1280,
  /** A picture larger than this is not sent to the window. */
  maxBytes: 600 * 1024,
} as const;

export const SNAPSHOT_FILE_RE = /^step-(\d{1,3})\.jpg$/;

export function snapshotFileName(stepNumber: number): string {
  return `step-${stepNumber}.jpg`;
}

/** The `screencapture` argv for one window picture by its window id, or null without one (a frame alone is never used). */
export function snapshotArgs(target: { windowId?: number | null; rect?: ShowOnceRect | null }, file: string): string[] | null {
  if (typeof target.windowId === "number" && Number.isInteger(target.windowId) && target.windowId > 0) {
    return ["-x", "-o", "-t", "jpg", `-l${target.windowId}`, file];
  }
  return null;
}

type Exec = (file: string, args: string[]) => Promise<boolean>;

const run: Exec = (file, args) => new Promise((resolve) => {
  try {
    execFile(file, args, { timeout: 5000 }, (err) => resolve(!err));
  } catch {
    resolve(false);
  }
});

/** One recording's pictures, while it records. Never throws. */
export class ShowOnceSnapshots {
  private taken = 0;
  private readonly pending: Promise<unknown>[] = [];

  constructor(readonly dir: string, private readonly exec: Exec = run) {}

  /** Takes the picture for SKILL.md step `stepNumber` (a later one for the same step replaces it). */
  take(stepNumber: number, target: { windowId?: number | null; rect?: ShowOnceRect | null }): void {
    if (this.taken >= SHOW_ONCE_SNAPSHOT_LIMITS.maxPictures || !Number.isInteger(stepNumber) || stepNumber < 1) return;
    const file = join(this.dir, snapshotFileName(stepNumber));
    const args = snapshotArgs(target, file);
    if (!args) return;
    this.taken++;
    const p = mkdir(this.dir, { recursive: true })
      .then(() => this.exec("/usr/sbin/screencapture", args))
      .then((ok) => (ok ? this.exec("/usr/bin/sips", ["-Z", String(SHOW_ONCE_SNAPSHOT_LIMITS.maxSide), file]) : false))
      .catch(() => false);
    this.pending.push(p);
  }

  /** Waits for the pictures being taken, then moves those of steps 1..`steps` into `<draftDir>/snapshots/`. */
  async moveInto(draftDir: string, steps: number): Promise<number> {
    await Promise.allSettled(this.pending);
    let moved = 0;
    try {
      const names = await readdir(this.dir).catch(() => [] as string[]);
      const keep = names.filter((n) => {
        const m = SNAPSHOT_FILE_RE.exec(n);
        return !!m && Number(m[1]) >= 1 && Number(m[1]) <= steps;
      });
      if (keep.length) {
        const to = join(draftDir, "snapshots");
        await mkdir(to, { recursive: true });
        for (const n of keep) {
          try {
            await rename(join(this.dir, n), join(to, n));
            moved++;
          } catch { /* that one is lost, the draft is not */ }
        }
      }
    } finally {
      await this.discard();
    }
    return moved;
  }

  /** Deletes this recording's pictures (Discard, an empty recording, a failed save). */
  async discard(): Promise<void> {
    await Promise.allSettled(this.pending);
    await rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The pictures of a saved draft, as data URLs for the review, in step order. */
export async function readDraftSnapshots(draftDir: string): Promise<Array<{ step: number; src: string }>> {
  const dir = join(draftDir, "snapshots");
  const names = await readdir(dir).catch(() => [] as string[]);
  const steps = names.map((n) => SNAPSHOT_FILE_RE.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b);
  const out: Array<{ step: number; src: string }> = [];
  for (const step of steps.slice(0, SHOW_ONCE_SNAPSHOT_LIMITS.maxPictures)) {
    const file = join(dir, snapshotFileName(step));
    try {
      if ((await stat(file)).size > SHOW_ONCE_SNAPSHOT_LIMITS.maxBytes) continue;
      out.push({ step, src: `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}` });
    } catch { /* gone meanwhile */ }
  }
  return out;
}
