/**
 * Brings the managed chat daemon back when it dies under a TUI that owns
 * it, so a crash, an OOM kill or a stray `kill -9` costs the operator a
 * few seconds of `provider_waiting` instead of a dead session.
 *
 * What it restarts is deliberately narrow: only a daemon this TUI
 * started or adopted (`owns()`), only on the managed route that is
 * actually serving the session (`enabled()` — managed mode, the local
 * route active, `localModels.managed.autoRestart` on), and only after
 * the pid has been seen dead on `DEAD_TICKS_TO_RESTART` ticks in a row,
 * so a restart already running by hand is never raced. The operator's
 * own stop clears `owns()` and the supervisor goes quiet with it.
 *
 * A turn in flight needs nothing from here: a request refused by a dead
 * daemon is a waitable outage, so the agent loop parks the step
 * (`provider_waiting`) and replays it once the server answers again.
 *
 * Crash-loop guard: a daemon that dies — or a restart that fails —
 * within `QUICK_DEATH_MS` of its start counts as a quick death; at the
 * `MAX_QUICK_DEATHS`th in a row the supervisor stops, says why (the
 * recognised fault from the server's log when there is one) and waits
 * for the operator to start the daemon again. Relaunching a model that
 * cannot fit, forever, is worse than stopping.
 */

export const SUPERVISOR_TICK_MS = 3_000;
export const DEAD_TICKS_TO_RESTART = 2;
export const QUICK_DEATH_MS = 60_000;
export const MAX_QUICK_DEATHS = 3;

export interface DaemonSupervisorDeps {
  /** Managed mode, local route active, `autoRestart` on. */
  enabled: () => boolean;
  /** The TUI started or adopted the daemon, and the operator has not stopped it. */
  owns: () => boolean;
  /** Is the pid in our pid file alive? */
  pidAlive: () => Promise<boolean>;
  /** Single-flight restart (stop what is left, start again). */
  restart: () => Promise<boolean>;
  say: (line: string) => void;
  /** One-line fault summary from the daemon's log, if any. */
  describeFault: () => string | null;
  /**
   * Asked on every tick where the pid is alive: why the live daemon is
   * wedged, or `null` (see `WedgeWatch`). Omitted = never wedged.
   */
  checkWedge?: () => Promise<string | null>;
  /** A new daemon starts a new wedge record. */
  resetWedge?: () => void;
  now?: () => number;
}

export class DaemonSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deadTicks = 0;
  private quickDeaths = 0;
  private lastStartAt: number;
  private recovering: Promise<boolean> | null = null;
  private gaveUp = false;
  private ticking = false;

  constructor(
    private readonly deps: DaemonSupervisorDeps,
    private readonly tickMs: number = SUPERVISOR_TICK_MS,
  ) {
    this.lastStartAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A start or restart the operator (or anything else) just made: the
   * crash-loop clock starts over and a supervisor that gave up listens
   * again.
   */
  noteStarted(): void {
    this.deps.resetWedge?.();
    this.lastStartAt = this.now();
    this.gaveUp = false;
    this.deadTicks = 0;
  }

  /** One observation; exported for tests and for an immediate check. */
  async tick(): Promise<void> {
    if (this.ticking || this.recovering) return;
    this.ticking = true;
    try {
      if (!this.deps.enabled() || !this.deps.owns() || this.gaveUp) {
        this.deadTicks = 0;
        return;
      }
      if (await this.deps.pidAlive()) {
        this.deadTicks = 0;
        const wedged = (await this.deps.checkWedge?.()) ?? null;
        if (wedged) await this.recover(wedged);
        return;
      }
      this.deadTicks += 1;
      if (this.deadTicks < DEAD_TICKS_TO_RESTART) return;
      await this.recover("the model server died");
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Restart now, with the crash-loop accounting. Concurrent callers share
   * one attempt. Exported for the wedge watchdog, which has already
   * decided the daemon is gone for all practical purposes.
   */
  recover(reason: string): Promise<boolean> {
    if (this.recovering) return this.recovering;
    this.recovering = this.runRecovery(reason).finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  private async runRecovery(reason: string): Promise<boolean> {
    this.deadTicks = 0;
    this.deps.resetWedge?.();
    // A daemon that stayed up past the window proved itself: its death
    // starts the count over.
    if (this.now() - this.lastStartAt <= QUICK_DEATH_MS) this.quickDeaths += 1;
    else this.quickDeaths = 0;
    if (this.quickDeaths >= MAX_QUICK_DEATHS) {
      this.giveUp();
      return false;
    }
    this.deps.say(`local-llm: ${reason} — restarting it (auto-restart)`);
    let ok = false;
    try {
      ok = await this.deps.restart();
    } catch {
      ok = false;
    }
    // A failed start leaves the pid dead, so the next ticks come back
    // here as a quick death — the guard counts it without a special case.
    this.lastStartAt = this.now();
    return ok;
  }

  private giveUp(): void {
    this.gaveUp = true;
    const fault = this.deps.describeFault();
    this.deps.say(
      `local-llm: the model server died ${MAX_QUICK_DEATHS} times within a minute of starting — ` +
        `stopped restarting it${fault ? `: ${fault}` : ""}. Start it again with /llm restart once that is fixed, ` +
        "or set localModels.managed.autoRestart to false to manage it by hand",
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
