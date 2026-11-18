/**
 * ATO-1503: Pause / Resume for a model download, on the agent's own resume.
 *
 * The window's weights download is a foreground `atag models pull <id>`
 * child (agent-cli.ts modelsPull). The agent writes into
 * `<dataDir>/models/<id>/<file>.part` with a `.part.json` sidecar, and the
 * next `models pull <id>` continues from the partial with an HTTP Range
 * request ("resuming … already on disk", src/cli/models-handlers.ts).
 * So, as in the agent's own `models downloads pause|resume|cancel` (ATO-446):
 *
 * - pause stops the child and keeps the partial file;
 * - resume runs the same pull again, which picks up at the partial's size;
 * - cancel stops it and deletes the partial.
 *
 * The slot stays taken while paused: one download at a time, as before,
 * and the window that started it still hears its single `done` frame.
 */
import { readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

export type PauseState = "running" | "pausing" | "paused" | "ended";

/** One child run: what agent-cli.ts modelsPull hands back. */
export interface PullRun<R> {
  done: Promise<R>;
  cancel: () => void;
}

export interface PausablePull<R> {
  /** The download's one outcome: finished, failed, or cancelled. Never a pause. */
  done: Promise<R>;
  /** Stop and keep the partial (quitting: the next launch resumes it). */
  cancel: () => void;
  /** The person's Cancel: stop, then delete the partial. */
  discard: () => void;
  pause: () => boolean;
  resume: () => boolean;
  state: () => PauseState;
}

export interface PauseHooks<R> {
  /** Delete what a cancelled download left on disk. */
  removePartial: () => void;
  /** The outcome a cancel ends with. */
  cancelled: () => R;
  /** Told after the child stopped for a pause (true) and as it starts again (false). */
  onPause?: (paused: boolean) => void;
}

export const DOWNLOAD_CANCELLED = "the download was cancelled";

/**
 * Wrap a pull so it can be paused. `start(resumed)` launches one child;
 * it is called again on every resume.
 */
export function pausablePull<R extends { ok: boolean }>(
  start: (resumed: boolean) => PullRun<R>,
  hooks: PauseHooks<R>,
): PausablePull<R> {
  let state: PauseState = "running";
  let discardAsked = false;
  let run: PullRun<R> | null = null;
  let finish: (r: R) => void = () => {};
  const done = new Promise<R>((resolve) => { finish = resolve; });

  const end = (r: R): void => {
    if (state === "ended") return;
    state = "ended";
    finish(r);
  };
  const removePartial = (): void => {
    try { hooks.removePartial(); } catch { /* best effort: the next pull overwrites it */ }
  };
  const launch = (resumed: boolean): void => {
    const mine = start(resumed);
    run = mine;
    void mine.done.then((res) => {
      if (run !== mine) return;
      run = null;
      // A pull that finished as it was stopped finished: its file is the model.
      if (res.ok) { end(res); return; }
      if (discardAsked) { removePartial(); end(hooks.cancelled()); return; }
      if (state === "pausing") {
        state = "paused";
        hooks.onPause?.(true);
        return;
      }
      end(res);
    });
  };
  launch(false);

  return {
    done,
    cancel: () => {
      if (run) { run.cancel(); return; }
      if (state === "paused") end(hooks.cancelled());
    },
    discard: () => {
      if (state === "ended") return;
      discardAsked = true;
      if (run) { run.cancel(); return; }
      removePartial();
      end(hooks.cancelled());
    },
    pause: () => {
      if (state !== "running" || !run || discardAsked) return false;
      state = "pausing";
      run.cancel();
      return true;
    },
    resume: () => {
      if (state !== "paused") return false;
      state = "running";
      hooks.onPause?.(false);
      launch(true);
      return true;
    },
    state: () => state,
  };
}

/** Another download refused while the slot is taken. */
export const DOWNLOAD_BUSY = "a download is already running";
/** The same refusal while the slot's pull is paused: the person has to Resume or Cancel it. */
export const DOWNLOAD_PAUSED_BUSY = "a download is paused: Resume or Cancel it first";

/** The refusal text for another download, given the slot's pull state (null: not a pausable pull). */
export function downloadBusyText(pullState: PauseState | null): string {
  return pullState === "paused" ? DOWNLOAD_PAUSED_BUSY : DOWNLOAD_BUSY;
}

/**
 * Whether a download keeps the updater waiting (updater.ts agentBusy).
 * A paused weights pull does not: nothing runs, and the update's quit
 * (cancel on a paused pull) ends it with the partial kept, so the next
 * launch resumes it. One download at a time still holds while paused.
 */
export function downloadBusyForUpdate(slotTaken: boolean, pullState: PauseState | null): boolean {
  return slotTaken && pullState !== "paused";
}

/** What the window is told about the slot's pull (`cli:pullPaused`). */
export function pauseFrame(id: string | null, state: PauseState | null): {
  id: string | null; pausable: boolean; paused: boolean; pausing: boolean;
} {
  const live = state !== null && state !== "ended";
  return {
    id: live ? id : null,
    pausable: live,
    paused: state === "paused",
    pausing: state === "pausing",
  };
}

/** The agent's partial-download files: `<file>.part` and its `<file>.part.json` sidecar. */
export function isPartialDownloadFile(name: string): boolean {
  return /\.part$/i.test(name) || /\.part\.json$/i.test(name);
}

/**
 * Delete the partial files in one model's folder (`<modelsDir>/<id>/`), as
 * `models downloads cancel` does. Finished files stay. Returns what went.
 */
export function removePartialDownloads(modelsDir: string, id: string): string[] {
  // The id is a folder name under modelsDir, never a path out of it.
  if (!id || id === "." || id === ".." || basename(id) !== id) return [];
  const dir = join(modelsDir, id);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const name of names) {
    if (!isPartialDownloadFile(name)) continue;
    try {
      rmSync(join(dir, name), { force: true });
      gone.push(name);
    } catch {
      /* left for the next pull, which overwrites it */
    }
  }
  return gone;
}
