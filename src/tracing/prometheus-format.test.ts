import { describe, expect, it } from "vitest";

import {
  escapeHelp,
  escapeLabelValue,
  formatPrometheus,
  formatValue,
  sanitizeLabelName,
  sanitizeMetricName,
} from "./prometheus-format.js";

describe("prometheus text format (ATO-646)", () => {
  it("escapes backslash, double quote and line feed in label values", () => {
    expect(escapeLabelValue('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd');
    expect(escapeLabelValue("plain")).toBe("plain");
  });

  it("escapes backslash and line feed in HELP, but not quotes", () => {
    expect(escapeHelp('say "hi"\\now\nnext')).toBe('say "hi"\\\\now\\nnext');
  });

  it("turns any name into a legal metric and label name", () => {
    expect(sanitizeMetricName("atomic_agent.turn.duration-ms")).toBe("atomic_agent_turn_duration_ms");
    expect(sanitizeMetricName("9lives")).toBe("_9lives");
    expect(sanitizeLabelName("cacheReused")).toBe("cache_reused");
    expect(sanitizeLabelName("gate-mode")).toBe("gate_mode");
    expect(sanitizeLabelName("1st")).toBe("_1st");
    expect(sanitizeLabelName("__reserved")).toBe("_reserved");
  });

  it("prints special floats the way Prometheus parses them", () => {
    expect(formatValue(Number.NaN)).toBe("NaN");
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe("+Inf");
    expect(formatValue(Number.NEGATIVE_INFINITY)).toBe("-Inf");
    expect(formatValue(1.5)).toBe("1.5");
  });

  it("renders counters, gauges and summaries with HELP and TYPE lines", () => {
    const text = formatPrometheus([
      {
        name: "atomic_agent_turn_completed_total",
        help: "Turns.",
        type: "counter",
        series: [
          { labels: { outcome: "reply", origin: "http" }, value: 3 },
          { labels: { outcome: "failed", origin: "http" }, value: 1 },
        ],
      },
      { name: "atomic_agent_turns_running", help: "Now.", type: "gauge", series: [{ labels: {}, value: 0 }] },
      {
        name: "atomic_agent_turn_duration_ms",
        help: "Time.",
        type: "summary",
        series: [{ labels: { outcome: "reply" }, count: 2, sum: 350 }],
      },
    ]);
    expect(text).toBe(
      [
        "# HELP atomic_agent_turn_completed_total Turns.",
        "# TYPE atomic_agent_turn_completed_total counter",
        'atomic_agent_turn_completed_total{origin="http",outcome="failed"} 1',
        'atomic_agent_turn_completed_total{origin="http",outcome="reply"} 3',
        "# HELP atomic_agent_turns_running Now.",
        "# TYPE atomic_agent_turns_running gauge",
        "atomic_agent_turns_running 0",
        "# HELP atomic_agent_turn_duration_ms Time.",
        "# TYPE atomic_agent_turn_duration_ms summary",
        'atomic_agent_turn_duration_ms_sum{outcome="reply"} 350',
        'atomic_agent_turn_duration_ms_count{outcome="reply"} 2',
        "",
      ].join("\n"),
    );
  });

  it("keeps a hostile label value on one line inside its quotes", () => {
    const text = formatPrometheus([
      {
        name: "atomic_agent_tool_call_total",
        help: "Tools.",
        type: "counter",
        series: [{ labels: { tool: 'x"} 1\nfake_metric 9' }, value: 1 }],
      },
    ]);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('atomic_agent_tool_call_total{tool="x\\"} 1\\nfake_metric 9"} 1');
  });

  it("prints nothing for no families", () => {
    expect(formatPrometheus([])).toBe("");
  });
});
