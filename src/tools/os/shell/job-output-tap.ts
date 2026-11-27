import type { CommandJob } from "../../../sandbox/command-job.js";

/**
 * What a host reads of a kept `os.shell.run` job while it runs (ATO-2485):
 * the desktop's terminal tab polls `read(since)` and draws the text as it
 * comes. One tap per job, made on the first read and kept until the job's
 * stdio closes; it never changes what the model reads.
 *
 * The tap starts from the job's capped snapshot (everything printed so
 * far, the middle dropped when it was large) and then hears each piece of
 * output through `CommandJob.onOutput`, both streams in arrival order. It
 * holds the newest `maxChars` characters; positions count every character
 * the tap ever took, so a reader that fell behind is told what it missed
 * instead of being handed a gap without notice.
 */

/** Characters a tap holds: enough for a long install log, bounded per job. */
export const JOB_TAP_MAX_CHARS = 256 * 1024;

export interface JobOutputSlice {
  /** Output from `since` (or from the oldest held character) to now. */
  text: string;
  /** The position to pass as `since` next time. */
  next: number;
  /** Characters before `text` that are no longer held (or were dropped by the snapshot cap). */
  dropped: boolean;
}

interface Tap {
  held: string;
  /** Position of `held[0]`. */
  start: number;
  /** The snapshot the tap started from had dropped its middle. */
  headDropped: boolean;
  readonly maxChars: number;
}

const taps = new WeakMap<CommandJob, Tap>();

function append(tap: Tap, text: string): void {
  tap.held += text;
  const over = tap.held.length - tap.maxChars;
  if (over > 0) {
    tap.held = tap.held.slice(over);
    tap.start += over;
  }
}

function tapOf(job: CommandJob, maxChars: number): Tap {
  const existing = taps.get(job);
  if (existing) return existing;
  const snapshot = job.output();
  const tap: Tap = { held: "", start: 0, headDropped: snapshot.truncated, maxChars };
  append(tap, snapshot.stdout + snapshot.stderr);
  // Synchronous after the snapshot: no chunk falls between the two.
  if (job.exited() === null) {
    const off = job.onOutput((text) => append(tap, text));
    const done = () => off();
    job.exit.then(done, done);
  }
  taps.set(job, tap);
  return tap;
}

/**
 * The job's output from position `since` (0 = from the start). A `since`
 * past the end, negative or not a whole number reads from the start of
 * what is held, so a confused reader re-syncs rather than stalls.
 */
export function readJobOutput(
  job: CommandJob,
  since: number,
  maxChars: number = JOB_TAP_MAX_CHARS,
): JobOutputSlice {
  const tap = tapOf(job, maxChars);
  const end = tap.start + tap.held.length;
  const valid = Number.isInteger(since) && since >= 0 && since <= end;
  const from = valid ? Math.max(since, tap.start) : tap.start;
  const dropped = (valid && since < tap.start) || (!valid && tap.start > 0) || (from === 0 && tap.headDropped);
  return { text: tap.held.slice(from - tap.start), next: end, dropped };
}
