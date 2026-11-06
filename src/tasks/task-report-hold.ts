import type { TaskReport, TaskReportSink } from "./task-report.js";
import type { HeldReportStore } from "./task-report-hold-store.js";
import { isQuietAt, nextQuietEnd, type QuietHours } from "./task-report-quiet-hours.js";

/**
 * Morning delivery for task reports. Wraps the real sink: a report
 * that finishes inside quiet hours is persisted instead of sent, and
 * when the window ends every held report goes out as ONE digest
 * message. Outside quiet hours reports pass straight through.
 *
 * Held reports live in a `HeldReportStore` (a table in tasks.sqlite in
 * production), so a restart in the night loses nothing: `start()`
 * schedules the release for whatever is already held. A digest that
 * cannot be delivered (channel down, not paired) stays held and is
 * retried every `retryMs`; it is removed only after a confirmed send.
 *
 * Timers are `unref`ed: a pending release never keeps the process
 * alive, and the next start picks the held rows up again.
 */
export interface TaskReportHoldOptions {
  quietHours: QuietHours;
  store: HeldReportStore;
  /** The ordinary sink, for reports outside quiet hours. */
  deliverNow: TaskReportSink;
  /** Sends held reports as one message; `true` only when delivered. */
  deliverDigest: (reports: readonly TaskReport[]) => Promise<boolean>;
  logger?: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
  };
  /** Test seams. */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  retryMs?: number;
}

/** How long an undelivered digest waits before the next try. */
export const HELD_REPORT_RETRY_MS = 5 * 60_000;

export class TaskReportHold {
  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  private timer: { cancel(): void } | null = null;
  private releasing: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: TaskReportHoldOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? defaultSetTimer;
  }

  /** The sink to hand the task runner. */
  readonly sink: TaskReportSink = async (report) => {
    const now = this.now();
    if (isQuietAt(this.options.quietHours, now)) {
      this.hold(report, now);
      this.schedule(this.msUntilRelease(now));
      return;
    }
    // Outside quiet hours with reports still held (a digest that could
    // not be sent yet): join them, so the morning reads as one message.
    if (this.options.store.list().length > 0) {
      this.hold(report, now);
      await this.release();
      return;
    }
    await this.options.deliverNow(report);
  };

  /** Schedule the release of reports held before this process started. */
  start(): void {
    if (this.options.store.list().length === 0) return;
    this.schedule(this.msUntilRelease(this.now()));
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  /**
   * Send everything held as one digest now, unless the window is still
   * open (a timer that fired early after a clock change re-arms).
   */
  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    this.releasing = this.releaseOnce().finally(() => {
      this.releasing = null;
    });
    return this.releasing;
  }

  private async releaseOnce(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (isQuietAt(this.options.quietHours, now)) {
      this.schedule(this.msUntilRelease(now));
      return;
    }
    const held = this.options.store.list();
    if (held.length === 0) return;
    let delivered = false;
    try {
      delivered = await this.options.deliverDigest(held.map((h) => h.report));
    } catch (err) {
      this.options.logger?.warn("held task report digest failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!delivered) {
      this.options.logger?.warn("held task reports not delivered; will retry", {
        count: held.length,
      });
      this.schedule(this.options.retryMs ?? HELD_REPORT_RETRY_MS);
      return;
    }
    this.options.store.remove(held.map((h) => h.id));
    this.options.logger?.info("held task reports delivered as one digest", {
      count: held.length,
    });
    // Reports held while the digest was in flight go out next.
    if (this.options.store.list().length > 0) this.schedule(0);
  }

  private hold(report: TaskReport, now: Date): void {
    const evicted = this.options.store.add(report, now.getTime());
    this.options.logger?.info("task report held for quiet hours", {
      taskId: report.taskId,
      until: this.options.quietHours.end,
    });
    if (evicted.length > 0) {
      this.options.logger?.warn("held task reports dropped: hold queue full", {
        taskIds: evicted.join(","),
      });
    }
  }

  private msUntilRelease(now: Date): number {
    if (!isQuietAt(this.options.quietHours, now)) return 0;
    return nextQuietEnd(this.options.quietHours, now).getTime() - now.getTime();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.release().catch((err: unknown) => {
        this.options.logger?.warn("held task report release failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, Math.max(0, ms));
  }
}

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
}
