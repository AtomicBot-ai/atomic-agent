/**
 * ATO-123 — the managed model server, brought back when it dies under the
 * app that started it.
 *
 * Valera's logs, 0.6.7: llama-server came up, closed twelve seconds later,
 * and came back only three minutes after that. Meanwhile a message got an
 * instant `fetch failed` seven times and sat out the agent's backoff
 * (2 → 4 → 8 → 16 → 30 s) for ninety seconds, until the turn was cancelled.
 * Nothing in the app ever started the server again, and nothing said that it
 * was down. The terminal agent has had this since 0.6
 * (src/tui/local-models/daemon-supervisor.ts, `localModels.managed.autoRestart`,
 * default true); the desktop ignored that setting. This is a port of the
 * same machine — the desktop cannot import src/ — with the rules Nadya set
 * for the app:
 *
 * - Only a server the app itself brought up (or found up when it asked for
 *   it) is brought back, and only until the app stops it on purpose:
 *   Settings' Stop, a switch to the cloud, a model change, the quit. Each of
 *   those is a `models stop` through agent-cli, which says so (noteStopped);
 *   from then on the server is nobody's to bring back until the app starts
 *   it again (noteStarted). A switch to the cloud stops the server under a
 *   turn that was using it; that is expected, and never fought.
 * - Only while the route needs it: Local models, or Fusion with a local seat
 *   (`wanted`, read from the config file as it is at that moment), and only
 *   with `localModels.managed.autoRestart` on. A route that stops needing it
 *   with no stop on purpose (a cloud switch over a server already down) ends
 *   an incident that is still open.
 * - Never under a start, a model load or a llama.cpp update: those are
 *   `busy` (any daemon turn on its way counts), and no dead look is counted
 *   while one runs. The restart itself takes the daemon's turn like every
 *   other start (backend-switch), so it queues behind any of them, and a stop
 *   or a switch ends it at once. The update's own stop is a stop on purpose
 *   (daemon-watch updateBegins), and a successful update starts the server
 *   again by itself.
 * - A death is confirmed on two looks in a row, a few seconds apart, before
 *   anything is done. When the agent itself reports the server refusing
 *   connections (`provider_waiting`, item 29's cause), that report is the
 *   second witness: one look, and the restart starts at once (checkNow).
 * - Crash-loop guard, as in the terminal: a server that dies — or a restart
 *   that fails — within QUICK_DEATH_MS of its start is a quick death; at the
 *   MAX_QUICK_DEATHS-th in a row the supervisor stops trying and says so
 *   (Settings › Models). The next start the person makes listens again, and
 *   counts afresh.
 *
 * Every dependency is handed in, so the T43 smoke drives the same object the
 * app runs.
 */

export const SUPERVISOR_TICK_MS = 3_000;
export const DEAD_LOOKS_TO_RESTART = 2;
export const QUICK_DEATH_MS = 60_000;
export const MAX_QUICK_DEATHS = 3;

/** The server at one look: answering or loading, gone, or something on its way (a start, a load, an update). */
export type DaemonLook = "up" | "down" | "busy";

/**
 * One incident, told as it goes: it opens at the first restart and closes
 * when a restart brings the server back, when the supervisor gives up, or
 * when anything else — a stop, a switch, the person's own start — makes it
 * moot (`clear`).
 */
export type SupervisorNotice =
  | { kind: "restarting"; reason: string; quickDeaths: number }
  | { kind: "restarted"; afterMs: number }
  | { kind: "restart_failed"; error: string | null; fault: string | null }
  | { kind: "gave_up"; deaths: number; fault: string | null }
  | { kind: "clear" };

export interface DaemonSupervisorDeps {
  /** autoRestart on, the managed mode, and a route that needs the local model now. */
  wanted(): boolean;
  /** The server right now. */
  look(): Promise<DaemonLook>;
  /** Bring it back. `superseded`: a stop or a switch ended the attempt. */
  restart(): Promise<{ ok: boolean; superseded?: boolean; error?: string }>;
  notify(notice: SupervisorNotice): void;
  /** A line for the agent log and the Diagnostics pane. */
  say(line: string): void;
  /** Why the server failed, from its log, or null. */
  describeFault(): string | null;
  now?(): number;
}

/** What the supervisor is doing, for the window and the smoke. */
export interface SupervisorState {
  armed: boolean;
  owned: boolean;
  recovering: boolean;
  gaveUp: boolean;
  quickDeaths: number;
  /** The open incident's last notice, or null. */
  incident: SupervisorNotice | null;
}

export class DaemonSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private owned = false;
  private deadLooks = 0;
  private quickDeaths = 0;
  private lastStartAt: number;
  private recovering: Promise<boolean> | null = null;
  private gaveUp = false;
  private ticking = false;
  /** Moves at every stop on purpose: a restart a stop came during is the stop's, not a success. */
  private stops = 0;
  private incidentSince: number | null = null;
  private incidentFailureTold = false;
  private last: SupervisorNotice | null = null;

  constructor(private readonly deps: DaemonSupervisorDeps) {
    this.lastStartAt = this.now();
  }

  /** Look every `tickMs` from now on. Answers the undo (a smoke check arms it for itself). */
  arm(tickMs: number = SUPERVISOR_TICK_MS): () => void {
    this.disarm();
    const timer = setInterval(() => void this.tick(), tickMs);
    timer.unref?.();
    this.timer = timer;
    return () => { if (this.timer === timer) this.disarm(); };
  }

  disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.deadLooks = 0;
  }

  state(): SupervisorState {
    return {
      armed: this.timer !== null,
      owned: this.owned,
      recovering: this.recovering !== null,
      gaveUp: this.gaveUp,
      quickDeaths: this.quickDeaths,
      incident: this.incidentSince !== null || this.gaveUp ? this.last : null,
    };
  }

  /**
   * The app brought the server up, or found it up when it asked for it: it is
   * the app's to bring back from here on. The crash-loop clock starts over,
   * and a supervisor that gave up listens again. The supervisor's own restart
   * comes through here too, and counts on: any other start ends an open
   * incident and starts the count of quick deaths afresh.
   */
  noteStarted(): void {
    const gaveUp = this.gaveUp;
    if (!this.recovering) {
      this.closeIncident(true);
      this.quickDeaths = 0;
    }
    this.owned = true;
    this.gaveUp = false;
    this.deadLooks = 0;
    this.lastStartAt = this.now();
    // The "stopped restarting it" notice goes once the person has started it again.
    if (gaveUp) this.notify({ kind: "clear" });
  }

  /** A stop on purpose: the server is nobody's to bring back until the app starts it again. */
  noteStopped(): void {
    this.owned = false;
    this.deadLooks = 0;
    this.stops += 1;
    if (this.gaveUp) {
      // The person has moved on from the server that kept dying; its notice goes with it.
      this.gaveUp = false;
      this.notify({ kind: "clear" });
    } else {
      this.closeIncident(true);
    }
  }

  /** One look; the timer's, and a smoke check's. */
  async tick(): Promise<void> {
    if (this.ticking || this.recovering) return;
    this.ticking = true;
    try {
      if (!this.listening()) {
        this.deadLooks = 0;
        this.settleWhenNotWanted();
        return;
      }
      const look = await this.deps.look();
      // The look takes a moment: a stop or a switch may have come during it.
      if (look !== "down" || !this.listening()) {
        this.deadLooks = 0;
        return;
      }
      this.deadLooks += 1;
      if (this.deadLooks < DEAD_LOOKS_TO_RESTART) return;
      await this.recover("the local model server stopped");
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The agent reports the server refusing connections: one look, and a
   * restart at once when it is down — the agent's report is the second
   * witness the timer would otherwise wait a few seconds for. Answers whether
   * it brought the server back.
   */
  async checkNow(reason: string): Promise<boolean> {
    if (this.recovering) return this.recovering;
    if (!this.listening()) return false;
    const look = await this.deps.look();
    if (look !== "down" || !this.listening()) return false;
    return this.recover(reason);
  }

  /**
   * Armed, owned, wanted, and not given up. Unarmed it does nothing at all:
   * a smoke run leaves it so, because its checks kill model servers by hand
   * on purpose and assert what happens next (T30, T31).
   */
  private listening(): boolean {
    return this.timer !== null && this.owned && !this.gaveUp && this.deps.wanted();
  }

  /**
   * The route stopped needing the server without a stop on purpose: a switch
   * to the cloud with the server already down (a cloud switch stops only a
   * server it finds running), the route pointed at another server, or
   * `autoRestart` turned off by hand. An open incident — or a "stopped
   * trying" — is then about a server nobody waits for any more: it is closed,
   * or the waiting strip, Settings › Models and a reopened window would go on
   * saying "trying again" for good.
   */
  private settleWhenNotWanted(): void {
    if (this.incidentSince === null && !this.gaveUp) return;
    if (this.timer === null || this.deps.wanted()) return;
    if (this.gaveUp) {
      // And the server that kept dying is nobody's any more: only a start the person makes listens again.
      this.gaveUp = false;
      this.owned = false;
      this.notify({ kind: "clear" });
      return;
    }
    this.closeIncident(true);
  }

  /** Restart now, with the crash-loop accounting. Concurrent callers share one attempt. */
  private recover(reason: string): Promise<boolean> {
    if (this.recovering) return this.recovering;
    const run = this.runRecovery(reason).finally(() => {
      if (this.recovering === run) this.recovering = null;
    });
    this.recovering = run;
    return run;
  }

  private async runRecovery(reason: string): Promise<boolean> {
    this.deadLooks = 0;
    // A server that stayed up past the window proved itself: its death starts the count over.
    if (this.now() - this.lastStartAt <= QUICK_DEATH_MS) this.quickDeaths += 1;
    else this.quickDeaths = 0;
    if (this.quickDeaths >= MAX_QUICK_DEATHS) {
      this.giveUp();
      return false;
    }
    const stops = this.stops;
    this.deps.say(`[desktop] local-llm: ${reason} — starting it again (auto-restart)`);
    if (this.incidentSince === null) {
      this.incidentSince = this.now();
      this.incidentFailureTold = false;
      this.notify({ kind: "restarting", reason, quickDeaths: this.quickDeaths });
    }
    let res: { ok: boolean; superseded?: boolean; error?: string };
    try {
      res = await this.deps.restart();
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // A stop or a switch came while it restarted: theirs is the last word, and noteStopped has told it.
    if (this.stops !== stops || res.superseded) {
      if (this.stops === stops) this.closeIncident(true);
      return false;
    }
    // A failed start leaves the server down, so the next looks come back here as a quick death.
    this.lastStartAt = this.now();
    if (res.ok) {
      const afterMs = this.now() - (this.incidentSince ?? this.now());
      this.deps.say(`[desktop] local-llm: the model server is back up after ${Math.round(afterMs / 1000)} s (auto-restart)`);
      this.notify({ kind: "restarted", afterMs });
      this.closeIncident(false);
      return true;
    }
    const fault = this.deps.describeFault();
    this.deps.say(
      `[desktop] local-llm: the automatic restart failed${res.error ? `: ${res.error}` : ""}${fault ? ` (${fault})` : ""} — trying again`,
    );
    if (!this.incidentFailureTold) {
      this.incidentFailureTold = true;
      this.notify({ kind: "restart_failed", error: res.error ?? null, fault });
    }
    return false;
  }

  /** Close the open incident; `told`: say so (`clear`) when one was open. */
  private closeIncident(told: boolean): void {
    const open = this.incidentSince !== null;
    this.incidentSince = null;
    this.incidentFailureTold = false;
    if (open && told) this.notify({ kind: "clear" });
  }

  private giveUp(): void {
    this.gaveUp = true;
    this.incidentSince = null;
    this.incidentFailureTold = false;
    const fault = this.deps.describeFault();
    this.deps.say(
      `[desktop] local-llm: the model server stopped ${MAX_QUICK_DEATHS} times within a minute of starting — `
        + `stopped restarting it${fault ? `: ${fault}` : ""}. Start it again in Settings › Models once that is fixed, `
        + "or set localModels.managed.autoRestart to false to manage it by hand",
    );
    this.notify({ kind: "gave_up", deaths: MAX_QUICK_DEATHS, fault });
  }

  private notify(notice: SupervisorNotice): void {
    this.last = notice;
    try {
      this.deps.notify(notice);
    } catch {
      /* a notice never fails the supervisor */
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
