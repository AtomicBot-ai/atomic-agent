import { describe, expect, it } from "vitest";

import {
  LOCAL_MODELS_CATALOG,
  type LocalModelDef,
  type LocalModelId,
} from "./models-catalog.js";
import { recommendedModelFor } from "./recommended-model.js";

function def(
  id: string,
  recommendedRamGb: number,
  extra?: Partial<LocalModelDef>,
): LocalModelDef {
  return {
    id: id as LocalModelId,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "https://example.invalid/model.gguf",
    fileSizeGb: recommendedRamGb / 2,
    sizeLabel: `${recommendedRamGb / 2} GB`,
    description: "test model",
    maxContextLength: 8192,
    contextLabel: "8K",
    minRamGb: recommendedRamGb - 2,
    recommendedRamGb,
    family: "qwen",
    supportsVision: false,
    ...extra,
  };
}

describe("recommendedModelFor (curated catalog)", () => {
  // The machine sizes people actually have. The answer is the best-ranked
  // well-known model that runs comfortably, not the biggest one that fits.
  it.each([
    [8, "qwen-3.5-4b"],
    [16, "qwen-3.5-9b"],
    [32, "gemma-4-26b-a4b"],
    [64, "qwen-3.6-35b-a3b"],
  ])("recommends a model for a %i GB machine", (ramGb, expected) => {
    expect(recommendedModelFor(ramGb)?.id).toBe(expected);
  });

  // A dense 27B answers far slower than a model with few active weights
  // (our own benchmark), so a 32 GB machine must not default to one.
  it("never recommends the biggest model or a dense 27B on a 32 GB machine", () => {
    expect(recommendedModelFor(32)?.id).not.toBe("nemotron-3.5-30b-a3b");
    expect(recommendedModelFor(32)?.id).not.toBe("qwen-3.8-27b");
  });

  it("ranks every few-active-weights model above a dense 27B+ it fits beside", () => {
    const ranked = LOCAL_MODELS_CATALOG.filter((m) => m.recommendRank !== undefined);
    const isMoe = (m: LocalModelDef): boolean => /-A\d+B\b/.test(m.name);
    const bigDense = ranked.filter((m) => !isMoe(m) && m.recommendedRamGb >= 24);
    expect(bigDense.length).toBeGreaterThan(0);
    for (const dense of bigDense) {
      for (const moe of ranked.filter(isMoe)) {
        if (moe.recommendedRamGb > dense.recommendedRamGb) continue;
        expect(moe.recommendRank!, `${moe.id} vs ${dense.id}`).toBeLessThan(
          dense.recommendRank!,
        );
      }
    }
  });

  it("only recommends a model the machine runs comfortably", () => {
    for (const ramGb of [8, 12, 16, 20, 24, 32, 48, 64, 128]) {
      const pick = recommendedModelFor(ramGb);
      expect(pick, `${ramGb} GB`).not.toBeNull();
      expect(pick!.recommendedRamGb).toBeLessThanOrEqual(ramGb);
    }
  });

  it("has nothing to recommend below the smallest model's comfort line", () => {
    expect(recommendedModelFor(4)).toBeNull();
  });

  it("respects a download ceiling", () => {
    const pick = recommendedModelFor(64, { maxDownloadGb: 8 });
    expect(pick?.id).toBe("qwen-3.5-9b");
    expect(pick!.fileSizeGb).toBeLessThanOrEqual(8);
  });

  it("never recommends the uncensored model on any host", () => {
    for (const ramGb of [1, 8, 16, 32, 64, 512]) {
      expect(recommendedModelFor(ramGb)?.uncensored).not.toBe(true);
    }
  });

  // The recommendation depends on the machine, so a static label would
  // contradict it on every other machine size: the catalog carries none.
  it("leaves the Recommended label to the rule, never to a static tag", () => {
    const tagged = LOCAL_MODELS_CATALOG.filter((m) => m.tag === "Recommended");
    expect(tagged.map((m) => m.id)).toEqual([]);
  });
});

describe("recommendedModelFor (rules)", () => {
  it("prefers rank over size", () => {
    const catalog = [
      def("big-unranked", 32),
      def("mid-ranked-2", 16, { recommendRank: 2 }),
      def("small-ranked-1", 8, { recommendRank: 1 }),
    ];
    expect(recommendedModelFor(32, { catalog })?.id).toBe("small-ranked-1");
  });

  it("skips ranked entries the machine cannot run comfortably", () => {
    const catalog = [
      def("big-ranked-1", 32, { recommendRank: 1 }),
      def("small-ranked-2", 8, { recommendRank: 2 }),
    ];
    expect(recommendedModelFor(16, { catalog })?.id).toBe("small-ranked-2");
  });

  it("ignores a ranked uncensored entry and an unranked catalog", () => {
    const edgy = def("edgy", 8, { recommendRank: 1, uncensored: true });
    expect(recommendedModelFor(64, { catalog: [edgy] })).toBeNull();
    expect(recommendedModelFor(64, { catalog: [def("plain", 8)] })).toBeNull();
    expect(recommendedModelFor(64, { catalog: [] })).toBeNull();
  });
});

describe("catalog ranking and descriptions", () => {
  it("gives every curated entry a plain description", () => {
    for (const m of LOCAL_MODELS_CATALOG) {
      expect(m.description.trim(), m.id).not.toBe("");
      expect(m.description, m.id).not.toMatch(/mamba|imatrix|\bQAT\b/i);
    }
  });

  it("ranks only Qwen and Gemma entries, each rank used once", () => {
    const ranked = LOCAL_MODELS_CATALOG.filter((m) => m.recommendRank !== undefined);
    expect(ranked.length).toBeGreaterThan(0);
    const ranks = ranked.map((m) => m.recommendRank);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (const m of ranked) {
      expect(["qwen", "gemma"], m.id).toContain(m.family);
      expect(m.uncensored, m.id).not.toBe(true);
    }
  });
});
