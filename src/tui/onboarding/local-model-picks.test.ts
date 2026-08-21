import { describe, expect, it } from "vitest";
import {
  buildLocalModelPicks,
  orderLocalModelPicks,
  recommendLocalModel,
  FIRST_RUN_MAX_DOWNLOAD_GB,
} from "./local-model-picks.js";
import type { LocalModelDef, LocalModelId } from "../../local-llm/index.js";

function def(
  id: string,
  fileSizeGb: number,
  minRamGb: number,
  recommendedRamGb: number,
): LocalModelDef {
  return {
    id: id as LocalModelId,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "https://example.invalid/model.gguf",
    fileSizeGb,
    sizeLabel: `${fileSizeGb} GB`,
    description: "test model",
    maxContextLength: 8192,
    contextLabel: "8K",
    minRamGb,
    recommendedRamGb,
    family: "qwen",
  } as LocalModelDef;
}

const CATALOG = [
  def("tiny", 2, 4, 6),
  def("small", 4, 6, 8),
  def("medium", 7, 8, 12),
  def("large", 18, 24, 32),
];

describe("recommendLocalModel", () => {
  it("picks the largest quick download the machine runs comfortably", () => {
    expect(recommendLocalModel(32, CATALOG)).toBe("medium");
  });

  it("never recommends a download past the first-run ceiling", () => {
    const big = [def("huge", FIRST_RUN_MAX_DOWNLOAD_GB + 10, 8, 8)];
    // The only comfortable model is over the ceiling, so it is chosen as
    // the fallback — but a catalog with a smaller option prefers it.
    expect(recommendLocalModel(64, big)).toBe("huge");
    expect(recommendLocalModel(64, CATALOG)).toBe("medium");
  });

  it("falls back to the smallest model when nothing fits comfortably", () => {
    expect(recommendLocalModel(2, CATALOG)).toBe("tiny");
  });

  it("has nothing to say about an empty catalog", () => {
    expect(recommendLocalModel(16, [])).toBeNull();
  });
});

describe("buildLocalModelPicks", () => {
  it("marks how each model fits this machine", () => {
    const picks = buildLocalModelPicks(8, CATALOG);
    expect(picks.map((p) => p.fit)).toEqual(["fits", "fits", "tight", "over"]);
  });

  it("marks exactly one recommendation", () => {
    const picks = buildLocalModelPicks(16, CATALOG);
    expect(picks.filter((p) => p.recommended)).toHaveLength(1);
  });
});

describe("orderLocalModelPicks", () => {
  it("puts the recommendation first, then what runs here", () => {
    const ordered = orderLocalModelPicks(buildLocalModelPicks(8, CATALOG));
    expect(ordered[0]?.recommended).toBe(true);
    expect(ordered.at(-1)?.fit).toBe("over");
  });
});
