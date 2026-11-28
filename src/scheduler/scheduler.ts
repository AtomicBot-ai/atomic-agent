import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { DrainOutcome } from "../tasks/task-runner.js";
import type { SchedulerLeadership } from "./scheduler-leadership.js";
import { settleWithGrace } from "./scheduler-settle.js";

/**
 * Minimal clock surface the scheduler depends on: `Date.now` /
 * `setInterval` / `clearInterval` in production, a fake timer in tests.
 * Narrow on purpose: the scheduler is the ONLY periodic timer source
 * introduced by Option 4, and this keeps that invariant greppable.
 */
export interface SchedulerClock {
  now(): number;
  setInterval(handler: () => void, ms: number): SchedulerTimerHandle;
  clearInterval(handle: SchedulerTimerHandle): void;
}

export type SchedulerTimerHandle = unknown;

/**
 * Subset of `TaskRunner` the scheduler actually needs. Declared
 * structurally so the scheduler test can pass a minimal fake instead
 * of standing up a full runner + sqlite store.
 */
export interface SchedulerTaskRunner {
  runDue(
    now: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DrainOutcome>;
}

export interface SchedulerOptions {
  taskRunner: SchedulerTaskRunner;
  /** Polling interval in milliseconds. Default wiring passes 5000. */
  tickMs: number;
  /**
   * Upper bound on the number of due tasks consumed per tick. The
   * runner still enforces per-session FIFO, so larger batches simply
   * let more independent sessions fire in parallel within one tick.
   */
  batch: number;
  logger?: StructuredLogger;
  metrics?: AgentMetrics;
  clock?: SchedulerClock;
  /**
   * Gate for the interval ticks when several processes share one state
   * dir (ATO-416, see `scheduler-leadership.ts`): only the leader drains.
   * Absent: always drain, the single-process behaviour. An explicit
   * `tickOnce()` is never gated — it is an operator asking for a drain.
   */
  leadership?: SchedulerLeadership;
  /**
   * Told when this process starts or stops leading (ATO-441: file
   * triggers watch only in the leader). Called on the first interval
   * tick (with or without a gate), on every hand-over, and with `false`
   * from `stop()` before the lock is released. A rejection is logged.
   */
  onLeadershipChange?: (leading: boolean) => void | Promise<void>;
  /**
   * Extra periodic work that must run in the same single process as the
   * drain — today the mail trigger (ATO-601), which turns new inbox
   * messages into tasks. Called on every interval tick this process
   * leads, after the leadership check and without waiting; each sidecar
   * throttles itself and must not throw. With a leadership gate, not on
   * the tick that gains leadership (#1735): the previous leader may have
   * started its own on its last tick and only stands by on its next.
   * The signal is aborted when this process stops leading or stops
   * (ATO-2508), so a sidecar tick still running on a former leader quits.
   */
  sidecars?: readonly SchedulerSidecar[];
}

export interface SchedulerSidecar {
  tick(now: number, signal: AbortSignal): Promise<void>;
}

const DEFAULT_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

/**
 * Owns the one `setInterval` introduced by Option 4. Every `tickMs`
 * the scheduler asks `TaskRunner.runDue(now, batch)` to claim and
 * execute any tasks whose `scheduled_for <= now`. Cross-cutting rules:
 *
 *  - holds no per-session state; never bypasses `TurnController`
 *  - swallows tick errors (logs + metric) so a bad task never crashes
 *    the interval
 *  - skips re-entry when a previous tick is still draining (avoids
 *    pile-ups when a tick takes longer than `tickMs`)
 *  - `stop()` clears the interval and refuses to start again, aborts
 *    the in-flight tick's task turns, and waits for the tick to settle
 *    so shutdown ordering is stable
 */
export class Scheduler {
  private readonly clock: SchedulerClock;
  private timer: SchedulerTimerHandle | null = null;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | null = null;
  /** Last leadership answer, to log hand-overs once rather than per tick. */
  private leading: boolean | null = null;
  /**
   * Handed to every tick's `runDue` and aborted by `stop()`: the drain
   * stops claiming, and the turn of the task it is running is stopped
   * (the runner puts that task back — see `TaskRunner.handleCancelled`).
   */
  private readonly stopController = new AbortController();
  /** One per leadership term; aborted on losing it or at `stop()` (ATO-2508). */
  private term: AbortController | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  /** Begin polling. Idempotent; never starts again after `stop()`. */
  start(): void {
    if (this.timer !== null) return;
    if (this.stopping) return;
    const handler = () => {
      const wasLeading = this.leading;
      if (!this.leads()) return;
      void this.tickOnce();
      // #1735: a process that just took leadership waits one tick before
      // its sidecars, so the one it took over from has seen the hand-over
      // on its own tick and stopped starting them.
      if (wasLeading === true || !this.options.leadership) this.tickSidecars();
    };
    this.timer = this.clock.setInterval(handler, this.options.tickMs);
  }

  /**
   * Run a tick now instead of at the next interval: the computer just
   * woke up (the desktop's `powerMonitor` "resume", ATO-592), so tasks
   * that fell due while it slept start at once. Unlike `tickOnce` this
   * respects leadership and does nothing before `start()` or after
   * `stop()`. Returns whether a tick was started.
   */
  poke(): boolean {
    if (this.timer === null || this.stopping) return false;
    if (this.running) return false;
    if (!this.leads()) return false;
    void this.tickOnce();
    return true;
  }

  /**
   * Stop polling. Clears the interval and aborts the in-flight tick
   * synchronously, then awaits that tick (if any) so callers can rely on
   * "no more runTurn calls originate here" once the promise settles.
   * The abort keeps that wait short: a turn waiting on a model server
   * that did not answer once held `serve`'s shutdown for minutes.
   * `graceMs` bounds the wait for a turn that ignores its signal; the
   * tick then finishes on its own, and its task is taken back by the
   * next boot (`TaskStore.recoverInterrupted`).
   */
  async stop(graceMs?: number): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    this.stopController.abort();
    this.term?.abort();
    try {
      await settleWithGrace(this.inFlight, graceMs);
    } finally {
      if (this.leading === true) {
        this.leading = false;
        await this.notifyLeadership(false);
      }
      // After the drain, so the other process takes over only once this
      // one has stopped claiming (or the grace ran out).
      this.options.leadership?.release();
    }
  }

  /**
   * Ask the leadership gate (if any) whether this process drains now.
   * A gate that throws fails open: running as before beats never running.
   */
  private leads(): boolean {
    const leadership = this.options.leadership;
    let leader = true;
    if (leadership) {
      try {
        leader = leadership.isLeader();
      } catch (err) {
        this.options.logger?.warn("scheduler leadership check failed; running", {
          error: err instanceof Error ? err.message : String(err),
        });
        leader = true;
      }
    }
    if (leader !== this.leading) {
      this.leading = leader;
      this.term?.abort();
      this.term = leader ? new AbortController() : null;
      if (leadership) {
        this.options.logger?.info(
          leader
            ? "scheduler: running due tasks in this process"
            : "scheduler: another process runs due tasks; standing by",
        );
      }
      void this.notifyLeadership(leader);
    }
    return leader;
  }

  /**
   * Ask the gate again right before acting on a leader-only event that
   * did not come from a tick: a file trigger hit (ATO-2508). The process
   * that takes over writes the lock before it starts its watchers, but a
   * former leader only notices on its next tick, so for up to `tickMs`
   * both watch the same files. A `false` answer here also stands this
   * process by at once (its watchers close). Never claims leadership it
   * did not already have, and is `false` once `stop()` began.
   */
  confirmLeadership(): boolean {
    if (this.stopping || this.leading !== true) return false;
    return this.leads();
  }

  private async notifyLeadership(leading: boolean): Promise<void> {
    const hook = this.options.onLeadershipChange;
    if (!hook) return;
    try {
      await hook(leading);
    } catch (err) {
      this.options.logger?.warn("scheduler leadership listener failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private tickSidecars(): void {
    const now = this.clock.now();
    const signal = this.term?.signal ?? this.stopController.signal;
    for (const sidecar of this.options.sidecars ?? []) {
      void sidecar.tick(now, signal).catch((err: unknown) => {
        this.options.logger?.warn("scheduler sidecar failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Execute one tick explicitly. Exposed for tests and for the
   * `atomic-agent task tick` CLI so operators can drain due tasks
   * without waiting for the interval. Re-entry guard identical to the
   * interval-driven path.
   */
  async tickOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const promise = this.doTick();
    this.inFlight = promise;
    try {
      await promise;
    } finally {
      this.running = false;
      this.inFlight = null;
    }
  }

  private async doTick(): Promise<void> {
    const start = this.clock.now();
    let batchSize = 0;
    try {
      const outcome = await this.options.taskRunner.runDue(
        start,
        this.options.batch,
        this.stopController.signal,
      );
      batchSize = outcome.drained;
      this.options.metrics?.recordSchedulerTick({
        batchSize,
        durationMs: this.clock.now() - start,
        outcome: "ok",
      });
    } catch (err) {
      this.options.logger?.warn("scheduler tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.options.metrics?.recordSchedulerTick({
        batchSize,
        durationMs: this.clock.now() - start,
        outcome: "error",
      });
    }
  }
}
