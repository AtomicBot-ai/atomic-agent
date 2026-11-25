/**
 * The OTLP/HTTP JSON encoding of `ExportTraceServiceRequest`, written by
 * hand so the export needs no OpenTelemetry packages. Shapes follow the
 * protobuf JSON mapping the OTLP specification pins: trace and span ids
 * are lowercase hex (not base64), 64-bit integers and nanosecond
 * timestamps are decimal strings, enums are their integer values.
 */
import { randomBytes } from "node:crypto";

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** `SPAN_KIND_INTERNAL` / `SPAN_KIND_CLIENT`. */
export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;

/** `STATUS_CODE_UNSET` / `STATUS_CODE_OK` / `STATUS_CODE_ERROR`. */
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

export interface OtlpSpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  events?: OtlpSpanEvent[];
  status: { code: number; message?: string };
}

export interface OtlpExportRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeSpans: Array<{
      scope: { name: string; version?: string };
      spans: OtlpSpan[];
    }>;
  }>;
}

/** Scalar attribute values a span is built from; `undefined` is dropped. */
export type AttributeInput = string | number | boolean | readonly string[] | undefined;

export function toAnyValue(value: string | number | boolean | readonly string[]): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { arrayValue: { values: value.map((v) => ({ stringValue: v })) } };
}

/** Key/value list in insertion order, without the `undefined` entries. */
export function toAttributes(input: Readonly<Record<string, AttributeInput>>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

/** Wall-clock milliseconds as OTLP nanoseconds (a decimal string). */
export function msToUnixNano(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  const fractionNs = Math.round((Math.max(0, ms) - whole) * 1_000_000);
  return (BigInt(whole) * 1_000_000n + BigInt(fractionNs)).toString();
}

/** A random non-zero id of `bytes` bytes, as lowercase hex. */
function randomHexId(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

/** 16-byte trace id (32 hex characters). */
export const newTraceId = (): string => randomHexId(16);
/** 8-byte span id (16 hex characters). */
export const newSpanId = (): string => randomHexId(8);

export function buildExportRequest(
  spans: OtlpSpan[],
  resource: OtlpKeyValue[],
  scope: { name: string; version?: string },
): OtlpExportRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: resource },
        scopeSpans: [{ scope, spans }],
      },
    ],
  };
}
