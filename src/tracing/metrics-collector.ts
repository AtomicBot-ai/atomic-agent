export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricSample {
  name: string;
  /**
   * For a counter, the running total for this name and tag set; for a
   * gauge, the reading; for a histogram, one observation.
   */
  value: number;
  tags?: Record<string, string>;
  timestamp: number;
  /** Which facade call produced the sample, so an aggregating sink (the `/metrics` exposition, ATO-646) knows how to fold it. */
  kind?: MetricKind;
  /** Counters only: what this call added to `value`. */
  delta?: number;
}

export type MetricSink = (sample: MetricSample) => void;

export interface MetricsCollectorOptions {
  sinks: MetricSink[];
}

/**
 * Lightweight counter/gauge/histogram facade. All metrics are emitted as
 * individual samples to every configured sink; aggregation happens outside
 * (either in the Tauri UI or in the CLI debug view).
 */
export class MetricsCollector {
  private readonly counters = new Map<string, number>();
  private readonly tagKeys = new Map<string, string>();

  constructor(private readonly options: MetricsCollectorOptions) {}

  counter(name: string, delta = 1, tags?: Record<string, string>): void {
    const key = this.buildKey(name, tags);
    const next = (this.counters.get(key) ?? 0) + delta;
    this.counters.set(key, next);
    this.emit({
      name,
      value: next,
      ...(tags ? { tags } : {}),
      timestamp: Date.now(),
      kind: "counter",
      delta,
    });
  }

  gauge(name: string, value: number, tags?: Record<string, string>): void {
    this.emit({
      name,
      value,
      ...(tags ? { tags } : {}),
      timestamp: Date.now(),
      kind: "gauge",
    });
  }

  histogram(name: string, value: number, tags?: Record<string, string>): void {
    this.emit({
      name,
      value,
      ...(tags ? { tags } : {}),
      timestamp: Date.now(),
      kind: "histogram",
    });
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [key, value] of this.counters.entries()) {
      result[key] = value;
    }
    return result;
  }

  private buildKey(name: string, tags?: Record<string, string>): string {
    if (!tags) return name;
    const keys = Object.keys(tags).sort();
    const cached = this.tagKeys.get(name);
    if (cached) return cached;
    const suffix = keys.map((k) => `${k}=${tags[k]}`).join(",");
    return `${name}{${suffix}}`;
  }

  private emit(sample: MetricSample): void {
    for (const sink of this.options.sinks) {
      try {
        sink(sample);
      } catch {
        // sinks must never throw back.
      }
    }
  }
}
