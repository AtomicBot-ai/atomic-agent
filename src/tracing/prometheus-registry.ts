import type { MetricKind, MetricSample, MetricSink } from "./metrics-collector.js";
import type {
  PrometheusFamily,
  PrometheusSeries,
  PrometheusSummarySeries,
} from "./prometheus-format.js";

/**
 * Tags that become Prometheus labels. Everything else on a sample is
 * dropped and its series folded together: `sessionId`, task and memory
 * row ids would give every chat its own time series, which is the one
 * thing a Prometheus server cannot afford (unbounded cardinality).
 */
const LABEL_ALLOWLIST: ReadonlySet<string> = new Set([
  "outcome",
  "origin",
  "category",
  "provider",
  "tool",
  "status",
  "reason",
  "source",
  "direction",
  "resolver",
  "approved",
  "cacheReused",
  "gateMode",
  "site",
  "model",
]);

/** Beyond this many label sets a family stops growing (a tool name explosion, say). */
const MAX_SERIES_PER_FAMILY = 200;
const MAX_LABEL_VALUE_LENGTH = 120;
const PREFIX = "atomic_";

/** Help lines for the series an operator reaches for first. */
const HELP: Readonly<Record<string, string>> = {
  "agent.turn.completed": "Agent turns that ended, by origin and terminal reason.",
  "agent.turn.duration_ms": "Wall-clock time of one agent turn in milliseconds.",
  "agent.step.outcome": "Agent loop steps that ended, by outcome.",
  "agent.step.duration_ms": "Wall-clock time of one agent step in milliseconds.",
  "agent.llm.failure": "Turns that failed for good, by failure category and provider link.",
  "agent.llm.latency_ms": "Model call latency in milliseconds.",
  "agent.tool.call": "Tool calls, by tool.",
  "agent.tool.failure": "Tool calls that failed, by tool.",
};

interface ScalarFamily {
  kind: "counter" | "gauge";
  source: string;
  series: Map<string, PrometheusSeries>;
}

interface SummaryFamily {
  kind: "histogram";
  source: string;
  series: Map<string, PrometheusSummarySeries>;
}

type Family = ScalarFamily | SummaryFamily;

/** `agent.turn.completed` + counter → `atomic_agent_turn_completed_total`. */
export function prometheusNameFor(sampleName: string, kind: MetricKind): string {
  const base = `${PREFIX}${sampleName}`.replace(/[^a-zA-Z0-9_:]/g, "_");
  if (kind !== "counter") return base;
  return base.endsWith("_total") ? base : `${base}_total`;
}

function pickLabels(tags: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!tags) return labels;
  for (const key of Object.keys(tags)) {
    if (!LABEL_ALLOWLIST.has(key)) continue;
    const value = tags[key];
    if (typeof value !== "string") continue;
    labels[key] =
      value.length > MAX_LABEL_VALUE_LENGTH ? value.slice(0, MAX_LABEL_VALUE_LENGTH) : value;
  }
  return labels;
}

function labelKey(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.keys(labels).sort().map((k) => [k, labels[k]]));
}

/**
 * Folds the agent's metric samples into Prometheus families, in memory,
 * for `GET /metrics` (ATO-646). Install `sink` among the runtime's
 * metric sinks; read `families()` at scrape time.
 *
 * - counter samples add their `delta`, so dropping `sessionId` sums
 *   every session into one series;
 * - gauge samples keep the last reading per label set;
 * - histogram samples become a summary (`_count` and `_sum`), from
 *   which a dashboard derives rates and means.
 *
 * Samples without a `kind` (from a collector predating it) are ignored.
 */
export class PrometheusRegistry {
  private readonly byName = new Map<string, Family>();
  private dropped = 0;

  readonly sink: MetricSink = (sample) => this.observe(sample);

  observe(sample: MetricSample): void {
    const kind = sample.kind;
    if (kind === undefined || !Number.isFinite(sample.value)) return;
    const name = prometheusNameFor(sample.name, kind);
    let family = this.byName.get(name);
    if (!family) {
      family =
        kind === "histogram"
          ? { kind: "histogram", source: sample.name, series: new Map<string, PrometheusSummarySeries>() }
          : { kind, source: sample.name, series: new Map<string, PrometheusSeries>() };
      this.byName.set(name, family);
    }
    // One name, one type: a later sample of another kind is not ours to merge.
    if (family.kind !== kind) return;
    const labels = pickLabels(sample.tags);
    const key = labelKey(labels);
    if (family.kind === "histogram") {
      const current = family.series.get(key);
      if (current) {
        current.count += 1;
        current.sum += sample.value;
      } else if (this.admit(family.series.size)) {
        family.series.set(key, { labels, count: 1, sum: sample.value });
      }
      return;
    }
    const current = family.series.get(key);
    const next =
      family.kind === "counter"
        ? (current?.value ?? 0) + (sample.delta ?? 1)
        : sample.value;
    if (current) {
      current.value = next;
    } else if (this.admit(family.series.size)) {
      family.series.set(key, { labels, value: next });
    }
  }

  families(): PrometheusFamily[] {
    const out: PrometheusFamily[] = [];
    const names = [...this.byName.keys()].sort();
    for (const name of names) {
      const family = this.byName.get(name)!;
      const help = HELP[family.source] ?? `Agent metric ${family.source}.`;
      if (family.kind === "histogram") {
        out.push({ name, help, type: "summary", series: [...family.series.values()] });
      } else {
        out.push({ name, help, type: family.kind, series: [...family.series.values()] });
      }
    }
    out.push({
      name: `${PREFIX}metrics_series_dropped_total`,
      help: "Samples not exported because their metric already had the maximum number of label sets.",
      type: "counter",
      series: [{ labels: {}, value: this.dropped }],
    });
    return out;
  }

  private admit(size: number): boolean {
    if (size < MAX_SERIES_PER_FAMILY) return true;
    this.dropped += 1;
    return false;
  }
}
