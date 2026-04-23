import type { TraceEvent } from "./trace-event.js";

/**
 * Receiver for a single trace event. Sinks must never throw: the bus
 * swallows errors so a broken sink cannot break the agent loop.
 */
export type TraceSink = (event: TraceEvent) => void;

export interface TraceBus {
  emit(event: TraceEvent): void;
}

/**
 * Fan-out helper: relays each event to every sink and swallows
 * individual sink errors. Mirrors the contract of `stderrSink` in
 * `structured-logger.ts` — observability must never disrupt execution.
 */
export function createTraceBus(sinks: readonly TraceSink[]): TraceBus {
  return {
    emit(event: TraceEvent): void {
      for (const sink of sinks) {
        try {
          sink(event);
        } catch {
          // Sinks must never break the caller; swallow errors.
        }
      }
    },
  };
}
