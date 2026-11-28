/**
 * ATO-2513: reads the most recent session rows every few seconds while the
 * pet is on screen and hands them to PetOutsideTurns (pet-outside.ts), so
 * the pet also shows turns the desktop did not start: a cron task, a
 * Telegram message, the terminal on the same agent. One small GET per
 * read (`/api/sessions?limit=25&scope=all`), no model call; it stops when
 * the pet closes. A failed read (the agent restarting, a remote agent
 * gone) is skipped and the next one tries again.
 */

import type { PetTracker } from "./pet-events.js";
import { PET_OUTSIDE_POLL_MS, PET_OUTSIDE_ROWS, PetOutsideTurns, petSessionRows, type PetOutsideEnding } from "./pet-outside.js";

export interface PetOutsidePoll {
  readonly turns: PetOutsideTurns;
  stop(): void;
}

export interface PetOutsidePollDeps {
  /** GET /api/sessions for the newest `limit` rows of every folder. */
  read: (limit: number) => Promise<unknown>;
  tracker: PetTracker;
  /** Something changed: outside turns ended (maybe none) or one started. */
  changed: (endings: PetOutsideEnding[]) => void;
  intervalMs?: number;
}

export function startPetOutsidePoll(d: PetOutsidePollDeps): PetOutsidePoll {
  const turns = new PetOutsideTurns();
  let stopped = false;
  let busy = false;
  let since = Date.now();
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    const startedAt = Date.now();
    try {
      const rows = petSessionRows(await d.read(PET_OUTSIDE_ROWS));
      if (stopped) return;
      const before = turns.activity(startedAt);
      const endings = turns.update(rows, (id) => d.tracker.ownSession(id, since), startedAt);
      since = startedAt;
      if (endings.length || before !== turns.activity(startedAt)) d.changed(endings);
    } catch {
      /* the agent is away; the next read tries again */
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, d.intervalMs ?? PET_OUTSIDE_POLL_MS);
  timer.unref?.();
  void tick();
  return {
    turns,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
