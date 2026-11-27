import type { CommandJob } from "../../../sandbox/command-job.js";
import { formatExitStatus } from "./shell-result.js";
import { hideTypedSecretsText } from "./shell-job-secret.js";
import { JobLineWatch, type WatchedLine } from "./shell-job-watch.js";
import type { MonitorWake } from "./shell-monitor-wake.js";

/**
 * A monitor on a kept job (ATO-2436): `{"monitor": id, "until": "ready"}`
 * keeps listening after the call returns, and when the job prints a
 * matching line the session gets a notice in its conversation, even if
 * no turn is running (`shell-monitor-wake.ts` says how it gets there).
 * When the job exits on its own, one last notice says so.
 *
 * Bounds, so a chatty log cannot run the model in a loop:
 *  - matches are batched: the first one waits `batchMs` for company,
 *    then at most one notice every `cooldownMs`; matches in between are
 *    held and go out together with the next one;
 *  - at most `maxWakes` notices per monitor, then it turns itself off
 *    and the last notice says so;
 *  - at most `MONITOR_MAX_HELD_LINES` held lines, the oldest go first.
 * A notice nobody could take (no turn running and nothing that can wake
 * an idle session) is held and offered again after the cooldown.
 *
 * The monitor ends when the job is stopped or collected, when the
 * session ends, when it is turned off, or after its last notice.
 */

export const MONITOR_BATCH_MS = 2_000;
export const MONITOR_COOLDOWN_MS = 30_000;
export const MONITOR_MAX_WAKES = 20;
/** Matching lines quoted in one notice; the rest are counted. */
export const MONITOR_LINES_SHOWN = 10;
/** Matching lines held between notices. */
export const MONITOR_MAX_HELD_LINES = 200;
/** A line is cut to this in a notice. */
export const MONITOR_LINE_CHARS = 300;
/** After the exit, how long a `wait` or `kill` has to claim the job first. */
export const MONITOR_EXIT_SETTLE_MS = 250;

export interface JobMonitorOptions {
  sessionId: string;
  jobId: number;
  /** Head of the command line, for the notice. */
  command: string;
  /** The pattern as the model wrote it. */
  until: string;
  pattern: RegExp;
  job: CommandJob;
  deliver(wake: MonitorWake): boolean;
  /**
   * Whether the job is still the session's and was not stopped: a job
   * a `wait` collected or a `kill` stopped gets no exit notice.
   */
  stillOwned(): boolean;
  /** Test seams; production uses the constants above. */
  batchMs?: number;
  cooldownMs?: number;
  maxWakes?: number;
  exitSettleMs?: number;
}

export class JobMonitor {
  readonly until: string;
  /** Notices delivered so far. */
  wakes = 0;
  private held: WatchedLine[] = [];
  private heldDropped = 0;
  private exitStatus: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAllowedAt = 0;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly watch: JobLineWatch;
  private readonly batchMs: number;
  private readonly cooldownMs: number;
  private readonly maxWakes: number;

  constructor(private readonly options: JobMonitorOptions) {
    this.until = options.until;
    this.batchMs = options.batchMs ?? MONITOR_BATCH_MS;
    this.cooldownMs = options.cooldownMs ?? MONITOR_COOLDOWN_MS;
    this.maxWakes = options.maxWakes ?? MONITOR_MAX_WAKES;
    // Only lines printed from now on: what the job said before the
    // monitor existed was the model's to read already.
    this.watch = new JobLineWatch(options.job, { fromNow: true });
    void this.listen();
  }

  get active(): boolean {
    return !this.closed;
  }

  /** Matching lines waiting for the next notice. */
  get pending(): number {
    return this.held.length + this.heldDropped;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.watch.close();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async listen(): Promise<void> {
    try {
      while (!this.closed) {
        const outcome = await this.watch.waitForLine(this.options.pattern, 0, this.abort.signal);
        if (this.closed) return;
        if (outcome.kind === "matched") {
          this.hold(outcome.line);
          continue;
        }
        if (outcome.kind === "exited") this.atExit();
        return;
      }
    } catch {
      // A watch that fails must not take the process down; the monitor just ends.
      this.close();
    }
  }

  private hold(line: WatchedLine): void {
    this.held.push(line);
    if (this.held.length > MONITOR_MAX_HELD_LINES) {
      this.held.shift();
      this.heldDropped += 1;
    }
    this.schedule(this.batchMs);
  }

  private atExit(): void {
    const settle = setTimeout(() => {
      if (this.closed) return;
      if (!this.options.stillOwned()) {
        this.close();
        return;
      }
      const exit = this.options.job.exited();
      this.exitStatus = exit ? formatExitStatus(exit) : "?";
      // The exit is news on its own: it does not wait for the cooldown.
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.flush();
    }, this.options.exitSettleMs ?? MONITOR_EXIT_SETTLE_MS);
    settle.unref?.();
  }

  private schedule(minDelayMs: number): void {
    if (this.timer || this.closed) return;
    const delay = Math.max(minDelayMs, this.nextAllowedAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.closed) return;
    if (this.pending === 0 && this.exitStatus === null) return;
    // An exit notice offered again later: the job may be collected by now.
    if (this.exitStatus !== null && !this.options.stillOwned()) {
      this.close();
      return;
    }
    const last = this.exitStatus !== null || this.wakes + 1 >= this.maxWakes;
    const wake: MonitorWake = {
      sessionId: this.options.sessionId,
      jobId: this.options.jobId,
      command: this.options.command,
      lineCount: this.pending,
      exited: this.exitStatus !== null,
      text: this.render(last),
    };
    if (!this.options.deliver(wake)) {
      // Nobody could take it now: keep the lines, offer them again later.
      this.schedule(this.cooldownMs);
      return;
    }
    this.wakes += 1;
    this.held = [];
    this.heldDropped = 0;
    this.nextAllowedAt = Date.now() + this.cooldownMs;
    if (last) this.close();
  }

  private render(last: boolean): string {
    const { jobId, command, until } = this.options;
    const count = this.pending;
    const lines: string[] = [];
    if (count > 0) {
      lines.push(
        `[Monitor on background job ${jobId} (${command}): ${count} new line${count === 1 ? "" : "s"} matched ${JSON.stringify(until)}.]`,
      );
      const shown = this.held.slice(-MONITOR_LINES_SHOWN);
      for (const line of shown) {
        // A value typed into a job (ATO-2486) is hidden before the cut, so a cut leaves no piece of it.
        const raw = hideTypedSecretsText(this.options.sessionId, line.text);
        const text = raw.length > MONITOR_LINE_CHARS ? `${raw.slice(0, MONITOR_LINE_CHARS)}…` : raw;
        lines.push(line.stream === "stderr" ? `[stderr] ${text}` : text);
      }
      const notShown = count - shown.length;
      if (notShown > 0) lines.push(`(${notShown} earlier matching line${notShown === 1 ? "" : "s"} not shown)`);
    } else {
      lines.push(`[Monitor on background job ${jobId} (${command}).]`);
    }
    lines.push(
      "This is an automatic notice from the monitor you set, not a message from the user. Act on it if it matters for the task; otherwise answer in one short line.",
    );
    if (this.exitStatus !== null) {
      lines.push(`The job has exited (exit ${this.exitStatus}); the monitor is off. {"wait": ${jobId}} collects its output.`);
    } else if (last) {
      lines.push(
        `This was the monitor's last notice (at most ${this.maxWakes}); the job keeps running. {"monitor": ${jobId}, "until": …} sets it again; {"kill": ${jobId}} stops the job.`,
      );
    } else {
      lines.push(`The job is still running. {"monitor": ${jobId}} turns the monitor off; {"kill": ${jobId}} stops the job.`);
    }
    return hideTypedSecretsText(this.options.sessionId, lines.join("\n"));
  }
}
