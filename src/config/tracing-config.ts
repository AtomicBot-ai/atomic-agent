import { parseBool, parseBoolOrNull, parsePositiveInt } from "./config-primitives.js";
import { ConfigValidationError } from "./config-validation-error.js";

/**
 * OpenTelemetry export of trace events (ATO-496). Off unless an OTLP
 * endpoint is known, from here or from `OTEL_EXPORTER_OTLP_ENDPOINT` /
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; see `src/tracing/README.md`.
 * Independent of `trace.enabled`: spans can be exported with the local
 * NDJSON files off.
 */
export interface OtelTracingConfig {
  /** `null`: on when an endpoint is known. `false`: off, whatever the env says. */
  enabled: boolean | null;
  /** OTLP/HTTP base URL (`/v1/traces` is appended) or a full traces URL. */
  endpoint: string | null;
  /** Extra request headers, e.g. an `Authorization` header. */
  headers: Record<string, string>;
  /** Put prompt, reply, tool argument and error text into spans. */
  captureContent: boolean;
}

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
  /** Absent in hand-built runtime configs; export is then off. */
  otel?: OtelTracingConfig;
}

export interface UserTracingConfig {
  trace: {
    enabled: boolean | null;
    maxBytesPerSession: number;
  };
  otel: OtelTracingConfig;
}

export function createTracingDefaults(): UserTracingConfig {
  return {
    trace: {
      enabled: null,
      maxBytesPerSession: 10 * 1024 * 1024,
    },
    otel: {
      enabled: null,
      endpoint: null,
      headers: {},
      captureContent: false,
    },
  };
}

export function parseTracingConfig(
  mergedTrace: Record<string, unknown>,
  readDefaults: () => UserTracingConfig,
  otel: Record<string, unknown> = {},
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
    // Its own defaults, not `readDefaults()`: a caller's defaults may
    // predate the block, and it reads none of `trace`'s keys.
    otel: parseOtelTracingConfig(otel, () => createTracingDefaults().otel),
  };
}

function parseOtelTracingConfig(
  raw: Record<string, unknown>,
  readDefaults: () => OtelTracingConfig,
): OtelTracingConfig {
  return {
    enabled: parseBoolOrNull(
      raw.enabled ?? readDefaults().enabled,
      "tracing.otel.enabled",
    ),
    endpoint: parseEndpoint(raw.endpoint ?? readDefaults().endpoint),
    headers: parseHeaders(raw.headers ?? readDefaults().headers),
    captureContent: parseBool(
      raw.captureContent ?? readDefaults().captureContent,
      "tracing.otel.captureContent",
    ),
  };
}

function parseEndpoint(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new ConfigValidationError("tracing.otel.endpoint", "expected string or null");
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigValidationError("tracing.otel.headers", "expected object");
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new ConfigValidationError(`tracing.otel.headers.${key}`, "expected string");
    }
    out[key] = value;
  }
  return out;
}
