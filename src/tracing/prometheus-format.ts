/**
 * Prometheus text exposition format, version 0.0.4 (ATO-646). A small
 * hand-written formatter rather than a client library: the agent only
 * needs to print counters, gauges and summaries it already aggregates,
 * and this keeps `atag serve` free of a new dependency.
 *
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type PrometheusType = "counter" | "gauge" | "summary";

export interface PrometheusSeries {
  labels: Readonly<Record<string, string>>;
  value: number;
}

/** A summary series without quantiles: just how many and their total. */
export interface PrometheusSummarySeries {
  labels: Readonly<Record<string, string>>;
  count: number;
  sum: number;
}

export type PrometheusFamily =
  | { name: string; help: string; type: "counter" | "gauge"; series: readonly PrometheusSeries[] }
  | { name: string; help: string; type: "summary"; series: readonly PrometheusSummarySeries[] };

/** A metric name: `[a-zA-Z_:][a-zA-Z0-9_:]*`. Anything else becomes `_`. */
export function sanitizeMetricName(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[a-zA-Z_:]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

/**
 * A label name: `[a-zA-Z_][a-zA-Z0-9_]*`, never starting with `__`
 * (reserved). camelCase tags read as snake_case (`cacheReused` →
 * `cache_reused`), the Prometheus convention.
 */
export function sanitizeLabelName(raw: string): string {
  const snake = raw.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  let cleaned = snake.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned.startsWith("__") ? cleaned.replace(/^_+/, "_") : cleaned;
}

/** Label values escape backslash, double quote and line feed. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** HELP text escapes backslash and line feed (quotes stay as they are). */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Go-style float text: `NaN`, `+Inf`, `-Inf`, or the plain number. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map(
    (key) => `${sanitizeLabelName(key)}="${escapeLabelValue(labels[key] ?? "")}"`,
  );
  return `{${parts.join(",")}}`;
}

/**
 * Render families as one exposition document. Families keep the order
 * given; each family's series are sorted by their label text so two
 * scrapes of the same state print the same bytes.
 */
export function formatPrometheus(families: readonly PrometheusFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    const name = sanitizeMetricName(family.name);
    lines.push(`# HELP ${name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${name} ${family.type}`);
    if (family.type === "summary") {
      const rows = family.series.map((s) => ({ labels: formatLabels(s.labels), s }));
      rows.sort((a, b) => (a.labels < b.labels ? -1 : a.labels > b.labels ? 1 : 0));
      for (const { labels, s } of rows) {
        lines.push(`${name}_sum${labels} ${formatValue(s.sum)}`);
        lines.push(`${name}_count${labels} ${formatValue(s.count)}`);
      }
      continue;
    }
    const rows = family.series.map((s) => ({ labels: formatLabels(s.labels), s }));
    rows.sort((a, b) => (a.labels < b.labels ? -1 : a.labels > b.labels ? 1 : 0));
    for (const { labels, s } of rows) {
      lines.push(`${name}${labels} ${formatValue(s.value)}`);
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
