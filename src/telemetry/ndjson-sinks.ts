import { randomUUID } from "node:crypto";
import type { LogSink, LogRecord } from "./structured-logger.js";
import type { MetricSink, MetricSample } from "./metrics-collector.js";
import type {
  SidecarEvent,
  LogPayload,
  MetricPayload,
} from "../sidecar/sidecar-events.js";

export type SidecarEventEmitter = (event: SidecarEvent) => void;

/**
 * Builds a LogSink that serialises log records as NDJSON `log` events.
 * Consumers (Tauri host, CLI tailer) see a uniform structured stream.
 */
export function createLogNdjsonSink(emit: SidecarEventEmitter): LogSink {
  return (record: LogRecord) => {
    const event: SidecarEvent<"log", LogPayload> = {
      kind: "event",
      id: randomUUID(),
      type: "log",
      payload: {
        level: record.level,
        message: record.message,
        ...(record.context ? { context: record.context } : {}),
      },
    };
    emit(event);
  };
}

/**
 * Builds a MetricSink that emits metric samples as NDJSON `metric`
 * events. Sample timestamps are carried in the payload so the host can
 * fan out into dashboards without re-timestamping.
 */
export function createMetricNdjsonSink(emit: SidecarEventEmitter): MetricSink {
  return (sample: MetricSample) => {
    const event: SidecarEvent<"metric", MetricPayload & { timestamp: number }> = {
      kind: "event",
      id: randomUUID(),
      type: "metric",
      payload: {
        name: sample.name,
        value: sample.value,
        ...(sample.tags ? { tags: sample.tags } : {}),
        timestamp: sample.timestamp,
      },
    };
    emit(event);
  };
}
