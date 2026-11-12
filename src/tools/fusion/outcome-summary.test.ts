import { describe, expect, it } from "vitest";

import type { FusionOutcomeRow } from "./outcome-log.js";
import {
  formatDuration,
  formatUsd,
  summarizeOutcomes,
} from "./outcome-summary.js";

function row(over: Partial<FusionOutcomeRow> = {}): FusionOutcomeRow {
  return {
    v: 1,
    at: 1,
    leg: "local",
    model: "qwen3-27b",
    size: "large",
    briefChars: 7_000,
    files: 1,
    status: "failed",
    durationMs: 60_000,
    steps: 3,
    writes: 0,
    costUsd: null,
    ...over,
  };
}

const times = (n: number, over: Partial<FusionOutcomeRow>): FusionOutcomeRow[] =>
  Array.from({ length: n }, (_, i) => row({ at: i, ...over }));

describe("outcome summary (ATO-949)", () => {
  it("states a local model failing large tasks with the remedy", () => {
    expect(summarizeOutcomes(times(3, {}))).toEqual([
      "`qwen3-27b` (local) on large tasks: failed 3 of 3 here; split them or send them to a cloud model",
    ]);
  });

  it("says nothing below the sample floor", () => {
    expect(summarizeOutcomes(times(2, {}))).toEqual([]);
    expect(summarizeOutcomes(times(2, {}), { minSamples: 2 })).toHaveLength(1);
  });

  it("does not count cancelled or queued tasks", () => {
    const rows = [
      ...times(2, {}),
      row({ status: "cancelled" }),
      row({ status: "queued" }),
    ];
    expect(summarizeOutcomes(rows)).toEqual([]);
  });

  it("states a reliable group with its median time and cost", () => {
    const rows = [
      row({ leg: "cloud", model: "sonnet", size: "small", status: "ok", durationMs: 30_000, costUsd: 0.02 }),
      row({ leg: "cloud", model: "sonnet", size: "small", status: "ok", durationMs: 50_000, costUsd: 0.04 }),
      row({ leg: "cloud", model: "sonnet", size: "small", status: "ok", durationMs: 180_000, costUsd: 0.05 }),
      row({ leg: "cloud", model: "sonnet", size: "small", status: "max_steps" }),
    ];
    expect(summarizeOutcomes(rows)).toEqual([
      "`sonnet` (cloud) on small tasks: 3 of 4 ok, ~50 s each, ~$0.04 each",
    ]);
  });

  it("tells a failing cloud group to split, not to go to the cloud", () => {
    const rows = times(4, { leg: "cloud", model: "sonnet", status: "timeout" });
    expect(summarizeOutcomes(rows)[0]).toBe(
      "`sonnet` (cloud) on large tasks: failed 4 of 4 here; split them smaller",
    );
  });

  it("puts failing groups first, then by count, and is independent of row order", () => {
    const rows = [
      ...times(6, { size: "small", status: "ok" }),
      ...times(3, { size: "large" }),
      ...times(4, { size: "medium", status: "ok" }),
    ];
    const lines = summarizeOutcomes(rows);
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "`qwen3-27b` (local) on large tasks",
      "`qwen3-27b` (local) on small tasks",
      "`qwen3-27b` (local) on medium tasks",
    ]);
    expect(summarizeOutcomes([...rows].reverse())).toEqual(lines);
  });

  it("caps the number of facts", () => {
    const rows = ["a", "b", "c", "d"].flatMap((m) => times(3, { model: m }));
    expect(summarizeOutcomes(rows, { maxFacts: 2 })).toHaveLength(2);
    expect(summarizeOutcomes(rows)).toHaveLength(4);
  });

  it("rounds durations and dollars so the bytes do not jitter", () => {
    expect(formatDuration(4_000)).toBe("10 s");
    expect(formatDuration(44_000)).toBe("40 s");
    expect(formatDuration(58_000)).toBe("1 min");
    expect(formatDuration(170_000)).toBe("3 min");
    expect(formatUsd(1.234)).toBe("1.2");
    expect(formatUsd(0.0412)).toBe("0.04");
    expect(formatUsd(0.0034)).toBe("0.003");
    expect(formatUsd(0.0001)).toBe("0.001");
  });
});
