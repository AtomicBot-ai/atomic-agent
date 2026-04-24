import type { StructuredLogger } from "../telemetry/structured-logger.js";
import type { AgentMetrics } from "../telemetry/agent-metrics.js";
import type { DrainOutcome } from "../tasks/task-runner.js";

/**
 * Minimal clock surface the scheduler depends on. Production wiring
 * uses `Date.now` / `setInterval` / `clearInterval`; tests inject a
 * fake timer so ticks can be driven manually without real delays.
 *
 * Keeping the surface this narrow is deliberate: the scheduler is the
 * ONLY new periodic timer source introduced by Option 4, and gating
 * every `setInterval` call through this interface keeps that invariant
 * trivially greppable.
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
 *  - `stop()` clears the interval and refuses to start again; waits
 *    for the in-flight tick to settle so shutdown ordering is stable
 */
export class Scheduler {
  private readonly clock: SchedulerClock;
  private timer: SchedulerTimerHandle | null = null;
  private running = false;
  private stopping = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? DEFAULT_CLOCK;
  }

  /**
   * Begin polling. Idempotent — a second call while running is a
   * no-op. Never starts after `stop()` has been invoked (the
   * scheduler is single-use per runtime lifetime).
   */
  start(): void {
    if (this.timer !== null) return;
    if (this.stopping) return;
    const handler = () => {
      void this.tickOnce();
    };
    this.timer = this.clock.setInterval(handler, this.options.tickMs);
  }

  /**
   * Stop polling. Clears the interval synchronously, then awaits the
   * in-flight tick (if any) so callers can rely on "no more runTurn
   * calls originate here" after the returned promise settles.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // tickOnce already logs + metrics the error
      }
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
