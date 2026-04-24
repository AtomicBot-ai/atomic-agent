import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { StructuredLogger } from "../structured-logger.js";

import type { TraceEvent } from "./trace-event.js";
import { serializeTraceEvent } from "./trace-event.js";
import type { TraceSink } from "./trace-bus.js";

export interface NdjsonTraceSinkOptions {
  /** Directory containing per-session NDJSON files. Created on demand. */
  dir: string;
  /**
   * Hard cap in bytes on a single session's trace file. Writes stop
   * after the cap is reached — the sink emits a single final
   * `trace_truncated` marker and then ignores further events so the
   * runtime never pays for a runaway trace.
   */
  maxBytesPerSession: number;
  /** Optional logger — only used to warn about filesystem failures. */
  logger?: StructuredLogger;
}

/**
 * Resolve the on-disk path for a session trace. Exposed so tooling (CLI
 * `trace show/export`, tests) can open files without duplicating the
 * naming convention.
 */
export function traceFilePath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.ndjson`);
}

interface SessionWriterState {
  path: string;
  bytesWritten: number;
  overflown: boolean;
}

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
    const state: SessionWriterState = {
      path,
      bytesWritten,
      overflown: bytesWritten >= options.maxBytesPerSession,
    };
    states.set(sessionId, state);
    return state;
  };

  return (event: TraceEvent) => {
    if (!ensureDir()) return;
    const state = resolveState(event.sessionId);
    if (state.overflown) return;

    const line = serializeTraceEvent(event);
    const size = Buffer.byteLength(line, "utf8");

    if (state.bytesWritten + size > options.maxBytesPerSession) {
      const marker = serializeTraceEvent({
        type: "trace_truncated",
        seq: event.seq + 1,
        sessionId: event.sessionId,
        ts: Date.now(),
        reason: `trace file exceeded maxBytesPerSession=${options.maxBytesPerSession}`,
      });
      try {
        appendFileSync(state.path, marker, "utf8");
      } catch (err) {
        options.logger?.warn("trace: failed to append truncation marker", {
          sessionId: event.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      state.overflown = true;
      return;
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
      state.overflown = true;
    }
  };
}
