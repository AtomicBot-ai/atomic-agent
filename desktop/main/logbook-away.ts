/**
 * ATO-2526: whether the person is away, for the logbook's mark
 * (logbook-ipc.ts). Electron's powerMonitor says when the screen locks
 * and unlocks, and how long since the last input. While away, main's mark
 * carries `away: true` and the runtime skips without a screenshot
 * (src/logbook/logbook-sidecar.ts). A lock or an unlock beats at once, so
 * the first frame after a lock is not taken.
 *
 * Precedent: Rewind and Microsoft Recall stop on lock; ActivityWatch's AFK
 * watcher counts no input for minutes as away.
 */

import { powerMonitor } from "electron";

import { AWAY_IDLE_SECONDS, isAway } from "./logbook-prefs.js";

export function watchLogbookAway(onChange: () => void): () => boolean {
  let locked = false;
  const set = (value: boolean) => () => {
    if (locked === value) return;
    locked = value;
    onChange();
  };
  powerMonitor.on("lock-screen", set(true));
  powerMonitor.on("unlock-screen", set(false));
  powerMonitor.on("suspend", set(true));
  powerMonitor.on("resume", set(false));
  return () => {
    let idle = "unknown";
    try { idle = powerMonitor.getSystemIdleState(AWAY_IDLE_SECONDS); } catch { idle = "unknown"; }
    return isAway(idle, locked);
  };
}
