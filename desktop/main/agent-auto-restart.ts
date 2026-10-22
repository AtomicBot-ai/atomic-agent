/**
 * ATO-767 — the agent brought back when it exits on its own while running.
 *
 * Before this, an `atag serve` that died under a running app left the window
 * on "The agent exited (code …, signal …)" until the person found Restart
 * Agent Runtime in the menu or restarted the app. Now the app starts it
 * again by itself: up to three attempts within five minutes, after pauses of
 * 1 s, 5 s and 20 s. The count of attempts is forgotten after ten minutes of
 * normal running. After the third failed attempt it stops trying and the
 * window offers a Restart agent button instead.
 *
 * A deliberate stop (quit, a folder change, a model switch, Restart Agent
 * Runtime) cancels an attempt that is waiting and forgets the count: it is
 * whoever stopped the agent that starts it again. The start itself is
 * AgentClient.start(), which first comes back for an agent a previous run
 * left behind (reapOrphanedServe) and never spawns a second one beside the
 * agent it already has, so an attempt cannot put two agents on one state
 * directory.
 *
 * No Electron, no fs: main.ts wires it to the client, the window and the
 * reports; the unit test drives it with stand-in starts and a clock it moves.
 */

/** The pause before each attempt, in order. Their count is the number of attempts. */
export const AUTO_RESTART_DELAYS_MS: readonly number[] = [1_000, 5_000, 20_000];
/** The attempts counted against the limit are the ones made in this window. */
export const AUTO_RESTART_WINDOW_MS = 5 * 60_000;
/** This long running normally after an attempt, and the count starts again. */
export const AUTO_RESTART_RESET_MS = 10 * 60_000;
/** The chat line once an attempt brought the agent back. */
export const AGENT_RESTARTED_LINE = "The agent stopped unexpectedly and was restarted.";
/** The chat line once the attempts ran out; the Restart agent button goes beside it. */
export const AGENT_GAVE_UP_LINE = "The agent keeps stopping unexpectedly, so the app stopped restarting it.";

export type AutoRestartNotice =
  /** An attempt is waiting out its pause. `attempt` counts from 1. */
  | { kind: "scheduled"; attempt: number; delayMs: number }
  /** The attempt brought the agent back. */
  | { kind: "restarted"; attempt: number }
  /** The attempts ran out: the window offers the button. */
  | { kind: "gave_up"; attempts: number }
  /** The count was forgotten: ten minutes of normal running, or a deliberate stop. */
  | { kind: "reset" };

type Timer = unknown;

export interface AutoRestartDeps {
  /** Starts the agent for attempt `attempt` (from 1) and answers the status it ended in. */
  start: (attempt: number) => Promise<{ state?: string } | null | undefined>;
  notify: (notice: AutoRestartNotice) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

export class AgentAutoRestart {
  /** When each attempt in the current run of attempts was made. */
  private attempts: number[] = [];
  private timer: Timer | null = null;
  private resetTimer: Timer | null = null;
  /** Moves at every cancel: an attempt that began before it says nothing and schedules nothing. */
  private epoch = 0;
  private armed = true;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly deps: AutoRestartDeps;

  constructor(deps: AutoRestartDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Off in a smoke run, whose checks end agents on purpose; the ATO-767 check turns it on. */
  arm(on: boolean): void {
    this.armed = on;
    if (!on) this.cancel();
  }

  isArmed(): boolean {
    return this.armed;
  }

  /** Attempts made in the current run of attempts: 0 when the agent running was not started by one. */
  attemptsMade(): number {
    return this.attempts.length;
  }

  /** An attempt is waiting out its pause. */
  pending(): boolean {
    return this.timer !== null;
  }

  /**
   * AgentClient's `unexpected-exit`. Only an agent that was running counts:
   * one that died while it booted is the start's own failure, which an
   * attempt judges from the status its start ends in.
   */
  exited(phase: string | undefined): "scheduled" | "gave_up" | "ignored" {
    if (!this.armed || phase !== "running" || this.timer !== null) return "ignored";
    return this.next();
  }

  /** The agent is connected: once it has run normally for AUTO_RESTART_RESET_MS, the count starts again. */
  connected(): void {
    if (this.attempts.length === 0 || this.timer !== null) return;
    if (this.resetTimer !== null) this.clearTimer(this.resetTimer);
    this.resetTimer = this.setTimer(() => {
      this.resetTimer = null;
      this.attempts = [];
      this.deps.notify({ kind: "reset" });
    }, AUTO_RESTART_RESET_MS);
  }

  /** A deliberate stop: the waiting attempt is dropped and the count forgotten. */
  cancel(): void {
    this.epoch++;
    if (this.timer !== null) this.clearTimer(this.timer);
    if (this.resetTimer !== null) this.clearTimer(this.resetTimer);
    this.timer = null;
    this.resetTimer = null;
    const had = this.attempts.length > 0;
    this.attempts = [];
    if (had) this.deps.notify({ kind: "reset" });
  }

  private next(): "scheduled" | "gave_up" {
    if (this.resetTimer !== null) this.clearTimer(this.resetTimer);
    this.resetTimer = null;
    const now = this.now();
    this.attempts = this.attempts.filter((at) => now - at < AUTO_RESTART_WINDOW_MS);
    if (this.attempts.length >= AUTO_RESTART_DELAYS_MS.length) {
      this.deps.notify({ kind: "gave_up", attempts: this.attempts.length });
      return "gave_up";
    }
    const delayMs = AUTO_RESTART_DELAYS_MS[this.attempts.length]!;
    this.attempts.push(now);
    const attempt = this.attempts.length;
    const epoch = this.epoch;
    this.timer = this.setTimer(() => void this.fire(attempt, epoch), delayMs);
    this.deps.notify({ kind: "scheduled", attempt, delayMs });
    return "scheduled";
  }

  private async fire(attempt: number, epoch: number): Promise<void> {
    this.timer = null;
    if (epoch !== this.epoch) return;
    let status: { state?: string } | null | undefined = null;
    try {
      status = await this.deps.start(attempt);
    } catch {
      status = null;
    }
    // A stop came while it started: that stop's caller starts what it wants.
    if (epoch !== this.epoch) return;
    const state = status?.state;
    if (state === "connected") {
      this.deps.notify({ kind: "restarted", attempt });
      this.connected();
      return;
    }
    // The start gave way to a stop, or the app is quitting: nothing to judge.
    if (state === "stopped") return;
    this.next();
  }
}

/* The app's one instance, for the ATO-767 smoke check (main.ts hosts it). */
let hosted: AgentAutoRestart | null = null;

export function hostAutoRestart(restarter: AgentAutoRestart): void {
  hosted = restarter;
}

export function hostedAutoRestart(): AgentAutoRestart | null {
  return hosted;
}
