/**
 * ATO-2513: turns the desktop did not start (a cron task, a Telegram or
 * Discord message, the terminal on the same agent), as the pet sees them.
 *
 * The chat stream (AgentClient `chat`) carries only this window's own
 * turns, and `GET /api/events` only approval requests. What every turn
 * leaves, whoever started it, is its session row: `GET /api/sessions`
 * says `running` while a turn is in flight (in this process or another on
 * the same state dir) and, after it, the status it ended on, with
 * `turnCount` one higher. pet-ipc.ts reads the most recent rows every few
 * seconds while the pet is on screen and hands them here.
 *
 * Pure (no Electron import). A session one of the window's own turns runs
 * in, or just ran in, is skipped: the chat stream already told the pet.
 * The first read only takes the baseline, so a turn that ended before the
 * pet came up is never flashed.
 */

import type { PetEnding } from "./pet-events.js";

export interface PetSessionRow {
  id: string;
  status: string;
  turnCount: number;
  updatedAt: number;
}

/** What `/api/sessions` returns, cut to what the pet reads; anything malformed is dropped. */
export function petSessionRows(raw: unknown): PetSessionRow[] {
  const list = raw && typeof raw === "object" ? (raw as { sessions?: unknown }).sessions : null;
  if (!Array.isArray(list)) return [];
  const out: PetSessionRow[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.status !== "string") continue;
    out.push({
      id: o.id,
      status: o.status,
      turnCount: typeof o.turnCount === "number" && Number.isFinite(o.turnCount) ? o.turnCount : 0,
      updatedAt: typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt) ? o.updatedAt : 0,
    });
  }
  return out;
}

const BUSY = new Set(["running", "awaiting_approval", "awaiting_llm"]);

/** A turn is in flight on this row. */
export function petRowBusy(status: string): boolean {
  return BUSY.has(status);
}

/** How a finished turn's row reads in the pet's words. A turn that hit its step limit needs the person. */
export function petRowEnding(status: string): PetEnding {
  if (status === "failed" || status === "stalled") return "error";
  if (status === "cancelled") return "stopped";
  return "done";
}

/** A row not seen again for this long is taken as gone. */
export const PET_OUTSIDE_STALE_MS = 15 * 60_000;
/** How often pet-ipc.ts reads the rows while the pet is up. */
export const PET_OUTSIDE_POLL_MS = 5_000;
/** How many of the most recent rows it reads. */
export const PET_OUTSIDE_ROWS = 25;

export interface PetOutsideEnding {
  sessionId: string;
  ending: PetEnding;
}

export class PetOutsideTurns {
  private readonly last = new Map<string, { status: string; turnCount: number }>();
  private readonly running = new Map<string, number>();
  private primedAt: number | null = null;
  /** The newest `updatedAt` of the last read, on the agent's own clock. */
  private newestSeen = 0;

  /**
   * One read of the rows. `isOwn(id)` says the window's own turn runs, or
   * ran since the last read, in that session. Returns the outside turns
   * that ended since the last read.
   */
  update(rows: readonly PetSessionRow[], isOwn: (sessionId: string) => boolean, now: number): PetOutsideEnding[] {
    const endings: PetOutsideEnding[] = [];
    const primed = this.primedAt !== null;
    for (const row of rows) {
      const prev = this.last.get(row.id);
      this.last.set(row.id, { status: row.status, turnCount: row.turnCount });
      if (isOwn(row.id)) {
        this.running.delete(row.id);
        continue;
      }
      if (petRowBusy(row.status)) {
        this.running.set(row.id, now);
        continue;
      }
      if (!primed) continue;
      const wasRunning = this.running.delete(row.id);
      // Started and finished between two reads: only the count moved.
      const ranBetween = prev ? row.turnCount > prev.turnCount : row.updatedAt > this.newestSeen && row.turnCount > 0;
      if (wasRunning || ranBetween) endings.push({ sessionId: row.id, ending: petRowEnding(row.status) });
    }
    if (!primed) this.primedAt = now;
    for (const row of rows) this.newestSeen = Math.max(this.newestSeen, row.updatedAt);
    // Keep the bookkeeping small: forget rows that left the window long ago.
    if (this.last.size > PET_OUTSIDE_ROWS * 8) {
      const keep = new Set(rows.map((r) => r.id));
      for (const id of [...this.last.keys()]) if (!keep.has(id) && !this.running.has(id)) this.last.delete(id);
    }
    return endings;
  }

  /** Outside turns in flight read as thinking: the row does not say whether a tool runs. */
  activity(now: number): "thinking" | null {
    for (const [id, seenAt] of [...this.running]) {
      if (now - seenAt > PET_OUTSIDE_STALE_MS) this.running.delete(id);
    }
    return this.running.size > 0 ? "thinking" : null;
  }

  /** The sessions with an outside turn in flight, for the approvals they may hold. */
  runningIds(): string[] {
    return [...this.running.keys()];
  }
}
