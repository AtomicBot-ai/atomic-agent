/**
 * Where (and whether) trace events are exported as OpenTelemetry spans.
 *
 * Off by default. Export turns on when an endpoint is known: the config's
 * `tracing.otel.endpoint`, or one of the standard OpenTelemetry variables
 * (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`).
 * `tracing.otel.enabled: false` keeps it off even when the environment
 * names an endpoint, and so do `OTEL_SDK_DISABLED=true` and
 * `OTEL_TRACES_EXPORTER=none`.
 *
 * Only OTLP over HTTP with the JSON encoding is spoken (no extra
 * dependencies, nothing that hooks module loading and breaks the SEA
 * binary), so `OTEL_EXPORTER_OTLP_*_PROTOCOL` is not consulted.
 */

/** The `tracing.otel` block as the config resolves it. */
export interface OtelExportConfig {
  /** `null` defers to whether an endpoint is known; `false` forces off. */
  enabled: boolean | null;
  /** OTLP/HTTP base URL (`/v1/traces` is appended) or full traces URL. */
  endpoint: string | null;
  /** Extra request headers (an auth header, a project key). */
  headers: Readonly<Record<string, string>>;
  /**
   * Put prompt, reply, tool argument and error text into spans. Off by
   * default: without it spans carry names, models, token counts,
   * timings and outcomes only.
   */
  captureContent: boolean;
}

/** What the exporter needs, once export is known to be on. */
export interface OtlpExportSettings {
  /** Full URL the batches are POSTed to. */
  tracesUrl: string;
  headers: Record<string, string>;
  captureContent: boolean;
  serviceName: string;
  /** Extra resource attributes from `OTEL_RESOURCE_ATTRIBUTES`. */
  resourceAttributes: Record<string, string>;
}

export type OtelEnv = Readonly<Record<string, string | undefined>>;

const TRACES_PATH = "/v1/traces";
const DEFAULT_SERVICE_NAME = "atomic-agent";

/**
 * Parse an OpenTelemetry `key=value,key2=value2` list (the format of
 * `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES`). Values
 * are percent-decoded; entries without `=` or with an empty key are
 * skipped, as the specification asks, rather than failing the whole list.
 */
export function parseOtelKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw === undefined) return out;
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = decodeOrKeep(entry.slice(0, eq).trim());
    const value = decodeOrKeep(entry.slice(eq + 1).trim());
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
}

function decodeOrKeep(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `base` with `/v1/traces` appended, unless it already ends with it. */
function tracesUrlFromBase(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(TRACES_PATH) ? trimmed : `${trimmed}${TRACES_PATH}`;
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function nonEmpty(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type OtlpSettingsResult =
  | { kind: "off" }
  | { kind: "invalid"; reason: string }
  | { kind: "on"; settings: OtlpExportSettings };

/**
 * Resolve the export settings from the config block and the process
 * environment. The environment wins over the config, as it does for any
 * OpenTelemetry SDK: a traces-specific variable over the general one,
 * the general one over `tracing.otel.endpoint`.
 */
export function resolveOtlpExportSettings(
  config: OtelExportConfig | undefined,
  env: OtelEnv = process.env,
): OtlpSettingsResult {
  if (config?.enabled === false) return { kind: "off" };
  if (nonEmpty(env.OTEL_SDK_DISABLED)?.toLowerCase() === "true") return { kind: "off" };
  if (nonEmpty(env.OTEL_TRACES_EXPORTER)?.toLowerCase() === "none") return { kind: "off" };

  const tracesEnv = nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const baseEnv = nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const fromConfig = nonEmpty(config?.endpoint);
  // The traces-specific variable is used as given, per the specification.
  const tracesUrl = tracesEnv
    ?? (baseEnv ? tracesUrlFromBase(baseEnv) : undefined)
    ?? (fromConfig ? tracesUrlFromBase(fromConfig) : undefined);
  if (tracesUrl === undefined) {
    return config?.enabled === true
      ? { kind: "invalid", reason: "tracing.otel.enabled is true but no endpoint is set" }
      : { kind: "off" };
  }
  if (!isHttpUrl(tracesUrl)) {
    return { kind: "invalid", reason: "the OTLP endpoint is not an http(s) URL" };
  }

  const headers: Record<string, string> = {
    ...(config?.headers ?? {}),
    ...parseOtelKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseOtelKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };
  const resourceAttributes = parseOtelKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES);
  const serviceName = nonEmpty(env.OTEL_SERVICE_NAME)
    ?? resourceAttributes["service.name"]
    ?? DEFAULT_SERVICE_NAME;
  return {
    kind: "on",
    settings: {
      tracesUrl,
      headers,
      captureContent: config?.captureContent === true,
      serviceName,
      resourceAttributes,
    },
  };
}
