import { parseBoolOrNull, parsePositiveInt } from "./config-primitives.js";

export interface RuntimeTracingConfig {
  trace: {
    /**
     * Trace recording toggle.
     * - `true`  / `false`: explicit user choice (wins over the entry-point default).
     * - `null`: defer to the entry point. `createAgentRuntime` resolves it
     *   via `traceDefault`: CLI / TUI / serve use `true`, sidecar uses
     *   `false`. This keeps local debugging observable by default while
     *   embedded hosts stay silent unless they opt in.
     */
    enabled: boolean | null;
    /** Directory for per-session NDJSON trace files. */
    dir: string;
    /**
     * Hard cap on a single session's trace file. Crossing it drops
     * the OLDEST events, not the newest: the sink trims the head
     * back to half the cap and keeps recording.
     */
    maxBytesPerSession: number;
  };
}

export interface UserTracingConfig {
  trace: {
    enabled: boolean | null;
    maxBytesPerSession: number;
  };
}

export function createTracingDefaults(): UserTracingConfig {
  return {
    trace: {
      enabled: null,
      maxBytesPerSession: 10 * 1024 * 1024,
    },
  };
}

export function parseTracingConfig(
  mergedTrace: Record<string, unknown>,
  readDefaults: () => UserTracingConfig,
): UserTracingConfig {
  return {
    trace: {
      enabled: parseBoolOrNull(
        mergedTrace.enabled ?? readDefaults().trace.enabled,
        "tracing.trace.enabled",
      ),
      maxBytesPerSession: parsePositiveInt(
        mergedTrace.maxBytesPerSession ??
          readDefaults().trace.maxBytesPerSession,
        "tracing.trace.maxBytesPerSession",
      ),
    },
  };
}
