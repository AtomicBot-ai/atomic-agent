/**
 * The OpenTelemetry subscriber on the trace bus: a `TraceSink` that maps
 * events to spans (`otlp-span-mapper.ts`) and hands finished spans to
 * the batched OTLP/HTTP JSON exporter (`otlp-exporter.ts`).
 *
 * Built only when `resolveOtlpExportSettings` says export is on; with no
 * endpoint configured nothing here is constructed and nothing is sent.
 */
import type { KnownSecret } from "../../error-reporting/secret-detector.js";
import type { TraceSink } from "../trace/trace-bus.js";
import type { OtlpExportSettings } from "./otlp-config.js";
import {
  createOtlpExporter,
  type FetchLike,
  type OtlpExporter,
  type OtlpExporterLogger,
  type OtlpExporterOptions,
} from "./otlp-exporter.js";
import { toAttributes, type AttributeInput } from "./otlp-json.js";
import { createOtlpSpanMapper } from "./otlp-span-mapper.js";

export interface OtlpTraceSinkOptions {
  settings: OtlpExportSettings;
  /** `service.version` and the instrumentation scope version. */
  version?: string;
  knownSecrets?: () => readonly KnownSecret[];
  logger?: OtlpExporterLogger;
  fetch?: FetchLike;
  /** Exporter tuning, mainly for tests. */
  exporter?: Pick<
    OtlpExporterOptions,
    "maxQueueSize" | "maxBatchSize" | "scheduledDelayMs" | "exportTimeoutMs"
  >;
}

export interface OtlpTraceSink {
  sink: TraceSink;
  /** Send what is queued now. Never rejects. */
  flush(): Promise<void>;
  /**
   * End the turns still open (marked unfinished), send everything, and
   * stop. Bounded by `timeoutMs`. Never rejects.
   */
  shutdown(timeoutMs?: number): Promise<void>;
  exporter: OtlpExporter;
}

export function createOtlpTraceSink(options: OtlpTraceSinkOptions): OtlpTraceSink {
  const { settings } = options;
  const resource: Record<string, AttributeInput> = {
    ...settings.resourceAttributes,
    "service.name": settings.serviceName,
    "service.version": options.version,
    "telemetry.sdk.name": "atomic-agent",
    "telemetry.sdk.language": "nodejs",
  };
  const exporter = createOtlpExporter({
    tracesUrl: settings.tracesUrl,
    headers: settings.headers,
    resource: toAttributes(resource),
    scope: {
      name: "atomic-agent",
      ...(options.version !== undefined ? { version: options.version } : {}),
    },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...options.exporter,
  });
  const mapper = createOtlpSpanMapper({
    onSpan: (span) => exporter.enqueue(span),
    captureContent: settings.captureContent,
    ...(options.knownSecrets ? { knownSecrets: options.knownSecrets } : {}),
  });
  let stopped = false;
  return {
    sink: (event) => {
      if (stopped) return;
      mapper.handle(event);
    },
    flush: () => exporter.flush(),
    async shutdown(timeoutMs) {
      if (!stopped) {
        stopped = true;
        mapper.endAll();
      }
      await exporter.shutdown(timeoutMs);
    },
    exporter,
  };
}
