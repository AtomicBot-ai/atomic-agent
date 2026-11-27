/**
 * ATO-2513: the terminal pet's state machine. The same machine as the
 * desktop pet's (`desktop/main/pet-state.ts`, ATO-2391): the desktop is a
 * separate CommonJS build that cannot import `src/`, so the rules are kept
 * twice on purpose and held together by one table of cases,
 * `pet-machine.fixture.json`, which both test suites replay
 * (`pet-machine.test.ts` here, `desktop/test/pet-fixture.test.mjs` there).
 * A change to one machine that is not made to the other fails one of them.
 *
 * Pure: no timers of its own. The caller passes the clock and runs step()
 * again at the `nextAt` it returns.
 *
 * States, highest priority first:
 *
 *   waiting   an approval request waits for the person
 *   error     a turn just failed (shown for errorMs, then gone)
 *   working   a turn is running a tool
 *   thinking  a turn is reasoning or writing its reply
 *   done      a turn just finished (shown for doneMs, then gone)
 *   idle      nothing runs
 *   sleeping  nothing has run for sleepAfterMs
 *
 * The rules:
 * - the highest priority state wins;
 * - a state stays at least minShowMs before a LOWER one replaces it, so a
 *   quick tool call does not flicker thinking, working, thinking; a higher
 *   one replaces it at once (an approval never waits);
 * - done and error go back to idle by themselves;
 * - do not disturb: no done / error flashes.
 */

export type PetState = "waiting" | "error" | "working" | "thinking" | "done" | "idle" | "sleeping";
export type PetActivity = "thinking" | "working";
export type PetEnding = "done" | "error" | "stopped";

export const PET_STATES: readonly PetState[] = ["waiting", "error", "working", "thinking", "done", "idle", "sleeping"];

export const PET_PRIORITY: Readonly<Record<PetState, number>> = {
  waiting: 6,
  error: 5,
  working: 4,
  thinking: 3,
  done: 2,
  idle: 1,
  sleeping: 0,
};

export interface PetTiming {
  minShowMs: number;
  doneMs: number;
  errorMs: number;
  sleepAfterMs: number;
}

export const PET_TIMING: Readonly<PetTiming> = {
  minShowMs: 700,
  doneMs: 3_000,
  errorMs: 6_000,
  sleepAfterMs: 2 * 60_000,
};

export interface PetInputs {
  /** What the running turn does; null when none runs. */
  activity: PetActivity | null;
  /** An approval request (or a question) waits. */
  waiting: boolean;
}

export interface PetStep {
  state: PetState;
  /** When step() should run again although nothing happened; null for never. */
  nextAt: number | null;
}

export class PetMachine {
  private shown: PetState = "idle";
  private since: number;
  private quietSince: number;
  private flash: { state: "done" | "error"; until: number } | null = null;
  private dnd = false;
  private readonly timing: PetTiming;

  constructor(now: number, timing: Partial<PetTiming> = {}) {
    this.timing = { ...PET_TIMING, ...timing };
    this.since = now;
    this.quietSince = now;
  }

  get state(): PetState {
    return this.shown;
  }

  get doNotDisturb(): boolean {
    return this.dnd;
  }

  setDoNotDisturb(on: boolean): void {
    this.dnd = on;
    if (on) this.flash = null;
  }

  /** A turn ended. Stopped by the person: nothing to say. */
  ended(ending: PetEnding, now: number): void {
    // The quiet stretch before sleeping starts when the turn ends.
    this.quietSince = Math.max(this.quietSince, now);
    if (ending === "stopped" || this.dnd) return;
    // A fresh error is not covered by a later done of another turn.
    if (ending === "done" && this.flash?.state === "error" && this.flash.until > now) return;
    this.flash = ending === "error"
      ? { state: "error", until: now + this.timing.errorMs }
      : { state: "done", until: now + this.timing.doneMs };
  }

  /** The state to show now, and when to look again. */
  step(inputs: PetInputs, now: number): PetStep {
    const busy = inputs.waiting || inputs.activity !== null;
    if (busy) this.quietSince = now;
    if (this.flash && this.flash.until <= now) this.flash = null;

    const restAt = this.quietSince + this.timing.sleepAfterMs;
    const candidates: PetState[] = [now >= restAt ? "sleeping" : "idle"];
    if (inputs.waiting) candidates.push("waiting");
    if (inputs.activity) candidates.push(inputs.activity);
    if (this.flash) candidates.push(this.flash.state);
    const target = candidates.reduce((a, b) => (PET_PRIORITY[b] > PET_PRIORITY[a] ? b : a));

    let holdUntil: number | null = null;
    if (target !== this.shown) {
      const higher = PET_PRIORITY[target] > PET_PRIORITY[this.shown];
      if (higher || now - this.since >= this.timing.minShowMs) {
        this.shown = target;
        this.since = now;
      } else {
        holdUntil = this.since + this.timing.minShowMs;
      }
    }

    const times: number[] = [];
    if (holdUntil !== null) times.push(holdUntil);
    if (this.flash) times.push(this.flash.until);
    if (!busy && now < restAt) times.push(restAt);
    const future = times.filter((t) => t > now);
    return { state: this.shown, nextAt: future.length ? Math.min(...future) : null };
  }
}
