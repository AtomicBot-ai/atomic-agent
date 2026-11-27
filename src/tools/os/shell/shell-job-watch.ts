import type { CommandJob } from "../../../sandbox/command-job.js";

/**
 * Watching a job's output for a line (ATO-2358): `{"wait": id,
 * "until": "ready"}` returns as soon as the job prints a matching line,
 * instead of the model polling it with `sleep` and `tail`.
 *
 * One watch per job, made on its first `until` and kept on the record.
 * It starts with every line the job has printed so far (a dev server
 * that said "ready" before the wait still matches) and then hears each
 * new piece of output. A match consumes the lines up to and including
 * it, so the next `until` waits for the next match rather than the same
 * one. Lines are bounded: the oldest unread ones go first, and the
 * result says how many.
 */

/** Unread lines a watch holds; past it the oldest go. */
export const WATCH_MAX_LINES = 2_000;
/** A longer line is cut to this before matching (keeps a pattern cheap). */
export const WATCH_MAX_LINE_CHARS = 2_000;
/** Lines before the match a result shows. */
export const WATCH_CONTEXT_LINES = 5;
/** Longest pattern accepted. */
export const WATCH_MAX_PATTERN_CHARS = 500;

export interface WatchedLine {
  text: string;
  stream: "stdout" | "stderr";
}

export type WatchOutcome =
  | { kind: "matched"; line: WatchedLine; before: WatchedLine[]; dropped: number }
  | { kind: "exited"; dropped: number }
  | { kind: "elapsed"; dropped: number }
  | { kind: "aborted"; dropped: number };

/**
 * The model's pattern as a case-insensitive regular expression (a log
 * says "Ready" as often as "ready"), or why it is not one.
 */
export function compileWatchPattern(
  raw: unknown,
): { ok: true; pattern: RegExp } | { ok: false; message: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: "`until` must be a non-empty pattern, e.g. {\"wait\": 1, \"until\": \"ready|error\"}" };
  }
  if (raw.length > WATCH_MAX_PATTERN_CHARS) {
    return { ok: false, message: `\`until\` is longer than ${WATCH_MAX_PATTERN_CHARS} characters` };
  }
  try {
    return { ok: true, pattern: new RegExp(raw, "i") };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `\`until\` is not a valid regular expression (${why})` };
  }
}

function clip(text: string): string {
  return text.length > WATCH_MAX_LINE_CHARS ? text.slice(0, WATCH_MAX_LINE_CHARS) : text;
}

export class JobLineWatch {
  private readonly lines: WatchedLine[] = [];
  /** The last lines already read, for the context of a later match. */
  private recent: WatchedLine[] = [];
  private flushed = false;
  private readonly partial = { stdout: "", stderr: "" };
  private dropped = 0;
  private readonly wakers = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly job: CommandJob) {
    // Subscribe, then read the snapshot: no output can arrive between
    // the two (one thread), so nothing is missed or seen twice.
    this.unsubscribe = job.onOutput((text, stream) => this.take(text, stream));
    const seen = job.output();
    this.take(seen.stdout, "stdout");
    this.take(seen.stderr, "stderr");
    const atExit = () => this.flushAtExit();
    job.exit.then(atExit, atExit);
  }

  /** The job is gone: its unterminated last lines count too. Once. */
  private flushAtExit(): void {
    if (this.flushed) return;
    this.flushed = true;
    this.flush("stdout");
    this.flush("stderr");
    this.unsubscribe();
    this.wake();
  }

  /**
   * Resolve on the first unread line `pattern` matches, on the job's
   * exit (after its last lines were checked), when `ms` ran out (`0` =
   * no bound) or when `signal` aborts. The job is never stopped here.
   */
  async waitForLine(pattern: RegExp, ms: number, signal?: AbortSignal): Promise<WatchOutcome> {
    const deadline = ms > 0 && Number.isFinite(ms) ? Date.now() + ms : Number.POSITIVE_INFINITY;
    for (;;) {
      if (this.job.exited() !== null) this.flushAtExit();
      const matched = this.consumeMatch(pattern);
      if (matched) return matched;
      // `flushed`: also a job that could not be spawned, which never exits.
      if (this.job.exited() !== null || this.flushed) return { kind: "exited", dropped: this.takeDropped() };
      if (signal?.aborted) return { kind: "aborted", dropped: this.takeDropped() };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "elapsed", dropped: this.takeDropped() };
      await this.nextChange(remaining, signal);
    }
  }

  private consumeMatch(pattern: RegExp): WatchOutcome | null {
    const index = this.lines.findIndex((line) => {
      pattern.lastIndex = 0;
      return pattern.test(line.text);
    });
    if (index < 0) {
      // Nothing matched: what was read will not match later either.
      this.recent = [...this.recent, ...this.lines].slice(-WATCH_CONTEXT_LINES);
      this.lines.length = 0;
      return null;
    }
    const line = this.lines[index]!;
    const before = [...this.recent, ...this.lines.slice(0, index)].slice(-WATCH_CONTEXT_LINES);
    this.recent = [...before, line].slice(-WATCH_CONTEXT_LINES);
    this.lines.splice(0, index + 1);
    return { kind: "matched", line, before, dropped: this.takeDropped() };
  }

  private takeDropped(): number {
    const dropped = this.dropped;
    this.dropped = 0;
    return dropped;
  }

  private take(text: string, stream: "stdout" | "stderr"): void {
    if (text.length === 0) return;
    const parts = (this.partial[stream] + text).split(/\r?\n|\r/);
    this.partial[stream] = clip(parts.pop() ?? "");
    for (const part of parts) this.push({ text: clip(part), stream });
    this.wake();
  }

  private flush(stream: "stdout" | "stderr"): void {
    const rest = this.partial[stream];
    this.partial[stream] = "";
    if (rest.length > 0) this.push({ text: rest, stream });
  }

  private push(line: WatchedLine): void {
    this.lines.push(line);
    if (this.lines.length > WATCH_MAX_LINES) {
      const over = this.lines.length - WATCH_MAX_LINES;
      this.lines.splice(0, over);
      this.dropped += over;
    }
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /** Until new output, the exit, `ms`, or the abort. */
  private nextChange(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(ms, 2_147_000_000));
      this.wakers.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
