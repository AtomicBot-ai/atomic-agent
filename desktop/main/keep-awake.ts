/**
 * ATO-592 (G-61) — keep the computer awake for scheduled tasks.
 *
 * A task that runs at night stopped when the laptop went to sleep, and a
 * task due during sleep only started once someone woke the machine. The
 * agent already catches up a missed run once on wake (its task queue);
 * this keeps the computer from sleeping in the first place, with
 * Electron's `powerSaveBlocker` in `prevent-app-suspension` mode (the
 * screen may still turn off):
 *
 *   - Off (default): nothing changes.
 *   - While a Task Runs: held while the agent reports a running task.
 *   - Always: held while the app runs.
 *
 * Closing a MacBook's lid still puts it to sleep; no app can stop that.
 * The choice lives in userData (keep-awake.json): it is about this
 * computer, not the agent's settings shared with the terminal.
 *
 * Pure apart from the file and the blocker host handed in.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type KeepAwakeMode = "off" | "while-working" | "always";

export const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ["off", "while-working", "always"];

/** The menu's words for each mode, and the note under them. */
export const KEEP_AWAKE_LABELS: Readonly<Record<KeepAwakeMode, string>> = {
  off: "Off",
  "while-working": "While a Task Runs",
  always: "Always",
};
export const KEEP_AWAKE_LID_NOTE = "Closing a MacBook lid still puts it to sleep";

/** How often main asks the agent whether a task is running, in While a Task Runs. */
export const KEEP_AWAKE_POLL_MS = 30_000;

export function readKeepAwakeMode(userData: string): KeepAwakeMode {
  try {
    const raw = JSON.parse(readFileSync(join(userData, "keep-awake.json"), "utf8")) as { mode?: unknown };
    return (KEEP_AWAKE_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as KeepAwakeMode) : "off";
  } catch {
    return "off";
  }
}

export function writeKeepAwakeMode(userData: string, mode: KeepAwakeMode): void {
  try {
    writeFileSync(join(userData, "keep-awake.json"), `${JSON.stringify({ mode })}\n`, "utf8");
  } catch {
    /* a read-only userData keeps the default: off */
  }
}

/**
 * Whether the blocker should be held. `runningTasks` is null when the
 * agent could not say (not started yet, an older agent): no hold then,
 * except in Always. A remote agent's tasks run on its own computer, so
 * they never keep this one awake.
 */
export function blockerWanted(mode: KeepAwakeMode, runningTasks: number | null, remote = false): boolean {
  if (mode === "always") return true;
  if (mode === "off" || remote) return false;
  return (runningTasks ?? 0) > 0;
}

/** The slice of Electron's `powerSaveBlocker` this needs. */
export interface BlockerHost {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** One blocker at most, started and stopped as `sync` is told. */
export class KeepAwakeBlocker {
  private id: number | null = null;

  constructor(private readonly host: BlockerHost) {}

  get held(): boolean {
    return this.id !== null && this.host.isStarted(this.id);
  }

  sync(wanted: boolean): void {
    if (wanted) {
      if (this.held) return;
      this.id = this.host.start("prevent-app-suspension");
      return;
    }
    if (this.id !== null) {
      if (this.host.isStarted(this.id)) this.host.stop(this.id);
      this.id = null;
    }
  }
}
