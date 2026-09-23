import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { StructuredLogger } from "../structured-logger.js";

import type { TraceEvent, TraceTruncated } from "./trace-event.js";
import { serializeTraceEvent } from "./trace-event.js";
import type { TraceSink } from "./trace-bus.js";

export interface NdjsonTraceSinkOptions {
  /** Directory containing per-session NDJSON files. Created on demand. */
  dir: string;
  /**
   * Hard cap in bytes on a single session's trace file. The cap is
   * honoured by dropping the OLDEST events, not by refusing new ones:
   * when an append would cross it the sink rewrites the file keeping
   * only its tail, with a `trace_truncated` marker at the seam saying
   * what was lost. See `trimHeadInPlace` for why the tail is the half
   * worth keeping.
   */
  maxBytesPerSession: number;
  /** Optional logger — only used to warn about filesystem failures. */
  logger?: StructuredLogger;
}

/**
 * How much of the cap a trim leaves behind. A trim is O(file size) —
 * it reads the whole file and writes the surviving tail — so it must
 * buy enough headroom to pay for itself. Halving means one rewrite of
 * at most `cap` bytes buys `cap/2` bytes of appends, i.e. an amortised
 * ≤2 bytes rewritten per byte traced, no matter how long the session
 * runs. Trimming a thin slice instead would rewrite the whole file
 * every few events.
 */
const TRIM_TARGET_RATIO = 0.5;

/**
 * Bytes reserved for the `trace_truncated` marker when sizing the
 * surviving tail. The marker is a handful of numbers and a short
 * sentence, well under this; over-reserving only costs a few spare
 * bytes of headroom.
 */
const MARKER_BUDGET_BYTES = 512;

/**
 * Suffix given to the temp file a trim writes before renaming it over
 * the trace. Also the prefix `reapStaleTemps` scans for: a process
 * killed between the write and the rename leaves one behind, and
 * nothing else would ever delete it.
 */
const TEMP_SUFFIX = ".trim-";

/**
 * Resolve the on-disk path for a session trace. Exposed so tooling (CLI
 * `trace show/export`, tests) can open files without duplicating the
 * naming convention.
 *
 * There is exactly one file per session and there always will be:
 * `trace show/export`, the debug bundle and the issue report all read
 * this single path, so rotation into sibling files would silently hand
 * each of them half a trace. That is why the cap is enforced by
 * rewriting this file rather than by rolling over to a new one.
 */
export function traceFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.ndjson`);
}

interface SessionWriterState {
  path: string;
  bytesWritten: number;
  /**
   * Set only when the filesystem itself let us down (append failed, or
   * a trim could not be completed). Unlike the old `overflown` flag
   * this is never reached by simply writing a lot: a big trace trims
   * and carries on.
   */
  disabled: boolean;
  /** One warning per session for events too big to ever store. */
  oversizedWarned: boolean;
  /**
   * Size the last trim of this file actually produced — the floor a
   * further trim could not get below, because a preserved header plus
   * the marker are irreducible. Without this the guard on
   * `bytesWritten <= target` is not enough to bound the rewrite rate:
   * a file whose floor sits ABOVE the target can be shrunk by a few
   * bytes forever, paying a whole-file rewrite per event. `0` until
   * the first trim, which is the only rewrite that can be wasted.
   */
  trimFloor: number;
}

/** Monotonic suffix so two trims can never pick the same temp name. */
let tempCounter = 0;

/**
 * Build an append-only NDJSON sink that writes one file per session to
 * `<dir>/<sessionId>.ndjson`. The sink is resilient: filesystem errors
 * are logged once per session and the sink stops writing, but never
 * propagates to the caller.
 *
 * Byte accounting is exact because we pre-serialize the event and add
 * `Buffer.byteLength` before writing.
 */
export function createNdjsonTraceSink(
  options: NdjsonTraceSinkOptions,
): TraceSink {
  const states = new Map<string, SessionWriterState>();
  let dirInitialized = false;
  const ensureDir = (): boolean => {
    if (dirInitialized) return true;
    try {
      mkdirSync(options.dir, { recursive: true });
      dirInitialized = true;
      return true;
    } catch (err) {
      options.logger?.warn("trace: failed to create directory", {
        dir: options.dir,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const resolveState = (sessionId: string): SessionWriterState => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const path = traceFilePath(options.dir, sessionId);
    let bytesWritten = 0;
    try {
      const stat = statSync(path);
      bytesWritten = stat.size;
    } catch {
      // File does not exist yet — fresh session trace.
    }
    reapStaleTemps(options, path);
    // Deliberately NO "already over the cap, give up" flag here. A
    // resumed session whose file is over the cap — including one left
    // by an older build that stopped writing at the cap — trims on its
    // next event and keeps recording. Overflow used to be a permanent,
    // restart-surviving death sentence for a trace; it is now just a
    // size to deal with.
    const state: SessionWriterState = {
      path,
      bytesWritten,
      disabled: false,
      oversizedWarned: false,
      trimFloor: 0,
    };
    states.set(sessionId, state);
    return state;
  };

  return (event: TraceEvent) => {
    if (!ensureDir()) return;
    const state = resolveState(event.sessionId);
    if (state.disabled) return;

    const line = serializeTraceEvent(event);
    const size = Buffer.byteLength(line, "utf8");

    if (state.bytesWritten + size > options.maxBytesPerSession) {
      const target = Math.floor(options.maxBytesPerSession * TRIM_TARGET_RATIO);
      // Guard against paying O(file size) per event: if the file is
      // already at or below what a trim would leave, the event itself
      // is the thing that does not fit and rewriting buys nothing.
      // Drop that one event and keep the file. This is what bounds the
      // trim to at most one rewrite per `cap/2` bytes appended.
      //
      // `trimFloor` is the second half of that bound. A trim cannot
      // always reach `target` — a preserved header plus the marker is
      // irreducible — and when the floor sits above the target, "am I
      // above the target?" stays true forever and every single event
      // pays a whole-file rewrite for a few bytes of progress. Once a
      // trim has told us where the floor is, that is the number to
      // compare against.
      if (state.bytesWritten <= Math.max(target, state.trimFloor)) {
        warnOversized(state, event, size, options);
        return;
      }
      if (!trimHeadInPlace(state, event.sessionId, target, options)) {
        // A trim we could not finish degrades to the old behaviour —
        // stop writing — rather than risking a mangled file. The
        // original file is untouched: the rewrite goes through a temp
        // file and an atomic rename.
        state.disabled = true;
        return;
      }
      if (state.bytesWritten + size > options.maxBytesPerSession) {
        warnOversized(state, event, size, options);
        return;
      }
    }

    try {
      appendFileSync(state.path, line, "utf8");
      state.bytesWritten += size;
    } catch (err) {
      options.logger?.warn("trace: failed to append event", {
        sessionId: event.sessionId,
        path: state.path,
        error: err instanceof Error ? err.message : String(err),
      });
      state.disabled = true;
    }
  };
}

function warnOversized(
  state: SessionWriterState,
  event: TraceEvent,
  size: number,
  options: NdjsonTraceSinkOptions,
): void {
  if (state.oversizedWarned) return;
  state.oversizedWarned = true;
  options.logger?.warn("trace: event larger than the session cap, dropped", {
    sessionId: event.sessionId,
    type: event.type,
    bytes: size,
    maxBytesPerSession: options.maxBytesPerSession,
  });
}

/**
 * Rewrite `state.path` keeping only its tail, so the file lands at or
 * below `targetBytes`.
 *
 * Why the tail. The cap used to be enforced from the other end: the
 * first 10 MB of a session were kept and everything after was dropped
 * for good. That is exactly backwards for the job traces exist to do —
 * "what went wrong" lives at the END of a long session, and a
 * self-diagnosing agent reading its own trace would find a pristine
 * record of the opening minutes and nothing at all about the failure
 * it was asked to explain.
 *
 * The rewrite:
 *  - keeps a leading `session_started` row when the file has one, so
 *    `trace list` still shows the start time and `trace replay` still
 *    finds the working directory after a trim;
 *  - drops whole lines only, so the result is still line-by-line
 *    parseable NDJSON in chronological order;
 *  - puts a `trace_truncated` marker at the seam carrying how many
 *    events and bytes were lost, so no reader mistakes the first
 *    surviving row for the start of the session;
 *  - is crash-safe: the new content is written to a temp file in the
 *    same directory, flushed, and renamed over the original, so the
 *    trace is never missing or half-written, whatever happens
 *    mid-rewrite. A temp a hard kill strands is swept by the next
 *    process to touch the session (`reapStaleTemps`).
 *
 * Returns `false` if the rewrite could not be completed; the caller
 * treats that as a filesystem failure. Never throws.
 */
function trimHeadInPlace(
  state: SessionWriterState,
  sessionId: string,
  targetBytes: number,
  options: NdjsonTraceSinkOptions,
): boolean {
  const temp = `${state.path}${TEMP_SUFFIX}${process.pid}-${tempCounter++}`;
  try {
    const raw = readFileSync(state.path);

    // 1. Preserve a leading `session_started` row if there is one —
    //    but only while it is small next to the target. A header that
    //    is itself most of the budget leaves no room for the tail it
    //    was meant to introduce, and pins the file above the target
    //    for good, which is a rewrite per event (see `trimFloor`).
    //    Half the target is the line: the tail is the reason the file
    //    exists, so it gets at least half of what survives.
    const firstBreak = raw.indexOf(0x0a);
    let headerEnd = 0;
    if (firstBreak >= 0 && 2 * (firstBreak + 1) <= targetBytes) {
      const first = parseLine(raw.subarray(0, firstBreak));
      if (first?.type === "session_started") headerEnd = firstBreak + 1;
    }

    // 2. Pick the cut so the survivors fit the target with room for the
    //    header and the marker. Then round the cut FORWARD to the next
    //    line break: a partial line would not parse.
    const room = targetBytes - headerEnd - MARKER_BUDGET_BYTES;
    const wanted = room > 0 ? room : 0;
    let cut = Math.max(headerEnd, raw.length - wanted);
    if (cut > headerEnd) {
      const nextBreak = raw.indexOf(0x0a, cut - 1);
      cut = nextBreak >= 0 ? nextBreak + 1 : raw.length;
    }

    // 3. Count what the cut costs, and fold in any loss an earlier
    //    marker recorded — that marker sits at the head of the file and
    //    is itself about to be dropped, so its numbers would otherwise
    //    vanish with it.
    const dropped = raw.subarray(headerEnd, cut);
    let droppedEvents = countLines(dropped);
    let droppedBytes = dropped.length;
    const previous = findPreviousMarker(dropped);
    if (previous) {
      // The old marker is a tombstone, not a lost event, and its own
      // bytes were never trace data — so discount both and inherit the
      // totals it was carrying. Reading the running total off the file
      // rather than off in-memory state is what makes the count
      // survive a restart.
      droppedEvents += (previous.event.droppedEvents ?? 0) - 1;
      droppedBytes += (previous.event.droppedBytes ?? 0) - previous.bytes;
    }

    // 4. The marker stands in for the run of dropped events, so it
    //    carries the seq and timestamp of the last one: the file stays
    //    ordered by both, and a reader sees exactly where the gap ends.
    const last = lastLineEvent(dropped);
    const marker: TraceTruncated = {
      type: "trace_truncated",
      seq: last?.seq ?? 0,
      sessionId: last?.sessionId ?? sessionId,
      ts: last?.ts ?? Date.now(),
      reason:
        `trace file exceeded maxBytesPerSession=${options.maxBytesPerSession};` +
        ` dropped the oldest ${droppedEvents} event(s) to keep the tail`,
      droppedEvents,
      droppedBytes,
    };

    const markerBytes = Buffer.from(serializeTraceEvent(marker), "utf8");
    const next = Buffer.concat([
      raw.subarray(0, headerEnd),
      markerBytes,
      raw.subarray(cut),
    ]);
    // `rename` is atomic for the directory entry, not for the data
    // behind it: without the flush a power cut after the rename can
    // leave the trace pointing at an unwritten extent, i.e. lose the
    // whole file rather than half of it. One flush per `cap/2` bytes
    // of trace is nothing next to that.
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, state.path);
    state.bytesWritten = next.length;
    // The header and the marker are what no further trim can remove.
    state.trimFloor = headerEnd + markerBytes.length;
    return true;
  } catch (err) {
    options.logger?.warn("trace: failed to trim the head of the trace file", {
      path: state.path,
      error: err instanceof Error ? err.message : String(err),
    });
    rmSync(temp, { force: true });
    return false;
  }
}

function parseLine(line: Buffer): Partial<TraceEvent> | null {
  const text = line.toString("utf8").trim();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Partial<TraceEvent>;
  } catch {
    return null;
  }
}

function countLines(chunk: Buffer): number {
  let count = 0;
  for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) count += 1;
  // A file we did not write ourselves can end without a line break —
  // that last unterminated row is still an event we are dropping.
  if (chunk.length > 0 && chunk[chunk.length - 1] !== 0x0a) count += 1;
  return count;
}

/**
 * Delete temp files a previous trim of THIS session left behind. A
 * process killed between the write and the rename leaks one — up to
 * half the cap of raw, unredacted trace content under a name no reader
 * lists (`trace list` only globs `*.ndjson`), so nothing would ever
 * clean it up and it would accumulate one per crash.
 *
 * Only temps whose owning pid is gone are touched: another live
 * process trimming the same session id is already a losing race, but
 * pulling its temp out from under it would turn that into a hard
 * failure for no gain.
 */
function reapStaleTemps(options: NdjsonTraceSinkOptions, path: string): void {
  const prefix = `${basename(path)}${TEMP_SUFFIX}`;
  try {
    for (const name of readdirSync(options.dir)) {
      if (!name.startsWith(prefix)) continue;
      const pid = Number.parseInt(name.slice(prefix.length), 10);
      if (Number.isFinite(pid) && pid !== process.pid && isAlive(pid)) continue;
      rmSync(join(options.dir, name), { force: true });
    }
  } catch {
    // Best-effort housekeeping: a trace sink never fails on cleanup.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists and belongs to somebody else.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * A previous trim's marker, if the region about to be dropped contains
 * one. We build the file ourselves, so a prior marker is always the
 * first row after the preserved header — only that row is inspected,
 * which keeps this O(1) rather than a parse of everything dropped.
 */
function findPreviousMarker(
  dropped: Buffer,
): { event: TraceTruncated; bytes: number } | null {
  const end = dropped.indexOf(0x0a);
  const line = end >= 0 ? dropped.subarray(0, end) : dropped;
  const parsed = parseLine(line);
  if (parsed?.type !== "trace_truncated") return null;
  return { event: parsed as TraceTruncated, bytes: line.length + 1 };
}

function lastLineEvent(dropped: Buffer): Partial<TraceEvent> | null {
  if (dropped.length === 0) return null;
  // `dropped` ends on a line break, so start the search before it.
  const start = dropped.lastIndexOf(0x0a, dropped.length - 2);
  return parseLine(dropped.subarray(start + 1));
}
