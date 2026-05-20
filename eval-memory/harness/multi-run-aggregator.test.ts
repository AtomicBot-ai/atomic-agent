import { describe, expect, it } from "vitest";

import { seededRng } from "./bootstrap-ci.js";
import {
  aggregateMultiRun,
  buildAggregatedHeader,
  flattenAggregatedRow,
} from "./multi-run-aggregator.js";

type Row = {
  profile: string;
  category: string;
  substringAccuracy: number;
  meanPromptTokens: number;
};

const r = (
  profile: string,
  category: string,
  acc: number,
  tokens: number,
): Row => ({ profile, category, substringAccuracy: acc, meanPromptTokens: tokens });

describe("aggregateMultiRun", () => {
  it("joins rows across runs by composite key and computes mean + CI", () => {
    const runs: Row[][] = [
      [r("full_v2", "single_hop", 0.6, 9000), r("none", "single_hop", 0.3, 4000)],
      [r("full_v2", "single_hop", 0.7, 9100), r("none", "single_hop", 0.4, 4100)],
      [r("full_v2", "single_hop", 0.5, 9200), r("none", "single_hop", 0.2, 4050)],
    ];
    const out = aggregateMultiRun({
      runs,
      bucketKey: (row) => `${row.profile}::${row.category}`,
      identityKeys: ["profile", "category"],
      numericKeys: ["substringAccuracy", "meanPromptTokens"],
      bootstrapOptions: { iterations: 500, rng: seededRng(7) },
    });

    expect(out).toHaveLength(2);
    const fullV2 = out.find((row) => row.key === "full_v2::single_hop")!;
    expect(fullV2.contributingRuns).toBe(3);
    expect(fullV2.metrics.substringAccuracy!.mean).toBeCloseTo(0.6, 5);
    expect(fullV2.metrics.substringAccuracy!.n).toBe(3);
    expect(fullV2.metrics.substringAccuracy!.ciLow).toBeLessThanOrEqual(0.6);
    expect(fullV2.metrics.substringAccuracy!.ciHigh).toBeGreaterThanOrEqual(0.6);
    expect(fullV2.metrics.meanPromptTokens!.mean).toBeCloseTo(9100, 5);
  });

  it("tolerates a profile missing from one run", () => {
    const runs: Row[][] = [
      [r("full_v2", "single_hop", 0.5, 9000)],
      [r("full_v2", "single_hop", 0.6, 9100), r("none", "single_hop", 0.3, 4000)],
    ];
    const out = aggregateMultiRun({
      runs,
      bucketKey: (row) => `${row.profile}::${row.category}`,
      identityKeys: ["profile", "category"],
      numericKeys: ["substringAccuracy"],
      bootstrapOptions: { iterations: 500, rng: seededRng(1) },
    });

    const fullV2 = out.find((row) => row.key === "full_v2::single_hop")!;
    const none = out.find((row) => row.key === "none::single_hop")!;
    expect(fullV2.contributingRuns).toBe(2);
    expect(none.contributingRuns).toBe(1);
    expect(none.metrics.substringAccuracy!.n).toBe(1);
    expect(none.metrics.substringAccuracy!.ciLow).toBeCloseTo(0.3, 5);
    expect(none.metrics.substringAccuracy!.ciHigh).toBeCloseTo(0.3, 5);
  });

  it("skips non-numeric values without poisoning the metric sample", () => {
    type RowWithBad = Row & { meanDurationMs: number | string };
    const runs: RowWithBad[][] = [
      [{ ...r("full_v2", "single_hop", 0.5, 9000), meanDurationMs: 1000 }],
      [
        {
          ...r("full_v2", "single_hop", 0.6, 9100),
          meanDurationMs: "n/a" as unknown as string,
        },
      ],
      [{ ...r("full_v2", "single_hop", 0.7, 9200), meanDurationMs: 1200 }],
    ];
    const out = aggregateMultiRun<RowWithBad>({
      runs,
      bucketKey: (row) => `${row.profile}::${row.category}`,
      identityKeys: ["profile", "category"],
      numericKeys: ["meanDurationMs"],
      bootstrapOptions: { iterations: 500, rng: seededRng(2) },
    });

    const fullV2 = out.find((row) => row.key === "full_v2::single_hop")!;
    expect(fullV2.metrics.meanDurationMs!.n).toBe(2);
    expect(fullV2.metrics.meanDurationMs!.mean).toBeCloseTo(1100, 5);
  });

  it("returns sorted output by key for stable CSV diffs", () => {
    const runs: Row[][] = [
      [r("zeta", "x", 1, 1), r("alpha", "x", 1, 1), r("mu", "x", 1, 1)],
    ];
    const out = aggregateMultiRun({
      runs,
      bucketKey: (row) => `${row.profile}::${row.category}`,
      identityKeys: ["profile", "category"],
      numericKeys: ["substringAccuracy"],
    });
    expect(out.map((row) => row.key)).toEqual(["alpha::x", "mu::x", "zeta::x"]);
  });
});

describe("flattenAggregatedRow + buildAggregatedHeader", () => {
  it("emits a CSV-ready record with mean/ci/n triples", () => {
    const runs: Row[][] = [
      [r("full_v2", "single_hop", 0.5, 9000)],
      [r("full_v2", "single_hop", 0.7, 9200)],
    ];
    const [agg] = aggregateMultiRun({
      runs,
      bucketKey: (row) => `${row.profile}::${row.category}`,
      identityKeys: ["profile", "category"],
      numericKeys: ["substringAccuracy", "meanPromptTokens"],
      bootstrapOptions: { iterations: 500, rng: seededRng(3) },
    });

    const flat = flattenAggregatedRow(
      agg!,
      ["profile", "category"],
      ["substringAccuracy", "meanPromptTokens"],
    );
    const header = buildAggregatedHeader(
      ["profile", "category"],
      ["substringAccuracy", "meanPromptTokens"],
    );

    expect(header).toEqual([
      "profile",
      "category",
      "contributingRuns",
      "substringAccuracy_mean",
      "substringAccuracy_ci_low",
      "substringAccuracy_ci_high",
      "substringAccuracy_n",
      "meanPromptTokens_mean",
      "meanPromptTokens_ci_low",
      "meanPromptTokens_ci_high",
      "meanPromptTokens_n",
    ]);
    expect(flat.profile).toBe("full_v2");
    expect(flat.category).toBe("single_hop");
    expect(flat.contributingRuns).toBe(2);
    expect(flat.substringAccuracy_mean).toBeCloseTo(0.6, 4);
    expect(flat.substringAccuracy_n).toBe(2);
  });
});
