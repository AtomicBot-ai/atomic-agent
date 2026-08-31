import { describe, expect, it } from "vitest";
import {
  buildLocalModelPicks,
  buildLocalPickRows,
  describeDownloadingModel,
  orderLocalModelPicks,
  recommendLocalModel,
  FIRST_RUN_MAX_DOWNLOAD_GB,
} from "./local-model-picks.js";
import { LOCAL_MODELS_CATALOG, setCustomLocalModels } from "../../local-llm/index.js";
import type { LocalModelDef, LocalModelId } from "../../local-llm/index.js";

function def(
  id: string,
  fileSizeGb: number,
  minRamGb: number,
  recommendedRamGb: number,
  extra?: Partial<LocalModelDef>,
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
    ...extra,
  } as LocalModelDef;
}

const CATALOG = [
  def("tiny", 2, 4, 6),
  def("small", 4, 6, 8),
  def("medium", 7, 8, 12),
  def("large", 18, 24, 32),
];

const UNCENSORED_ID = "qwen-3.8-27b-uncensored";

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

  // The 16.5 GB uncensored file could never win the quick-download branch
  // anyway (the ceiling is 8 GB) — but the fallbacks pick by size, so the
  // guarantee is pinned across the whole RAM range, tiny hosts included.
  it("never auto-recommends the uncensored model on any host", () => {
    for (const ramGb of [1, 2, 4, 8, 16, 20, 24, 32, 48, 64, 128, 512]) {
      expect(recommendLocalModel(ramGb, LOCAL_MODELS_CATALOG)).not.toBe(
        UNCENSORED_ID,
      );
    }
  });

  // Structural, not accidental: even an uncensored model that would win
  // on every usual criterion (comfortable, under the ceiling, largest)
  // is excluded from the recommendation entirely.
  it("excludes uncensored entries from recommendation even when they would win", () => {
    const catalog = [
      def("tame", 2, 4, 6),
      def("edgy", 6, 4, 6, { uncensored: true, tag: "Use at your own risk" }),
    ];
    expect(recommendLocalModel(64, catalog)).toBe("tame");
    // And a catalog of only uncensored entries recommends nothing at all.
    expect(recommendLocalModel(64, [catalog[1]!])).toBeNull();
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

  // Pinned last even when the usual rule would rank it first: here the
  // uncensored model is the only one that fits the host at all.
  it("sinks an uncensored pick below every other model whatever its fit", () => {
    const catalog = [
      def("huge-a", 20, 24, 32),
      def("huge-b", 22, 24, 32),
      def("edgy", 3, 4, 6, { uncensored: true, tag: "Use at your own risk" }),
    ];
    const ordered = orderLocalModelPicks(buildLocalModelPicks(8, catalog));
    expect(ordered.map((p) => p.id)).toEqual(["huge-a", "huge-b", "edgy"]);
    expect(ordered.at(-1)?.fit).toBe("fits");
  });

  it("keeps the real catalog's uncensored entry as the last model row", () => {
    // 16 GB would otherwise slot the 16.5 GB file mid-pack among the
    // other "over" models; the pin overrides that size ordering.
    for (const ramGb of [4, 16, 64]) {
      const ordered = orderLocalModelPicks(
        buildLocalModelPicks(ramGb, LOCAL_MODELS_CATALOG),
      );
      expect(ordered.at(-1)?.id).toBe(UNCENSORED_ID);
      expect(ordered).toHaveLength(LOCAL_MODELS_CATALOG.length);
    }
  });

  // Small machines still see it — with an honest fit label, not a faked
  // one: 4 GB of RAM is under the 20 GB minimum, so the row says "over".
  it("keeps the uncensored row present and honest on a small host", () => {
    const ordered = orderLocalModelPicks(
      buildLocalModelPicks(4, LOCAL_MODELS_CATALOG),
    );
    const last = ordered.at(-1);
    expect(last?.id).toBe(UNCENSORED_ID);
    expect(last?.fit).toBe("over");
    expect(last?.tag).toBe("Use at your own risk");
    expect(last?.recommended).toBe(false);
  });
});

describe("buildLocalPickRows", () => {
  it("puts the Hugging Face row last, after every recommendation", () => {
    const rows = buildLocalPickRows(buildLocalModelPicks(16, CATALOG));
    expect(rows).toHaveLength(CATALOG.length + 1);
    expect(rows.slice(0, -1).every((row) => row.kind === "model")).toBe(true);
    expect(rows.at(-1)?.kind).toBe("hugging_face");
  });

  // The row is what the cursor length is derived from, so an empty
  // catalog still has to leave somewhere to go.
  it("offers the Hugging Face row even with no curated models", () => {
    expect(buildLocalPickRows([])).toEqual([{ kind: "hugging_face" }]);
  });

  // The full bottom of the first-run list, in order: every safe model,
  // then the uncensored one, then the Hugging Face escape hatch.
  it("puts the uncensored model directly above the Hugging Face row", () => {
    const rows = buildLocalPickRows(
      orderLocalModelPicks(buildLocalModelPicks(16, LOCAL_MODELS_CATALOG)),
    );
    expect(rows.at(-1)?.kind).toBe("hugging_face");
    const lastModel = rows.at(-2);
    expect(lastModel?.kind).toBe("model");
    if (lastModel?.kind === "model") {
      expect(lastModel.pick.id).toBe(UNCENSORED_ID);
      expect(lastModel.pick.tag).toBe("Use at your own risk");
    }
  });
});

describe("describeDownloadingModel", () => {
  it("uses the curated id, which is already the name people use", () => {
    expect(describeDownloadingModel("qwen-3.5-4b")).toBe("qwen-3.5-4b");
  });

  it("falls back to the raw id for a model no longer in the catalog", () => {
    expect(describeDownloadingModel("custom-gone")).toBe("custom-gone");
  });

  it("has something to say before a model has been chosen", () => {
    expect(describeDownloadingModel(null)).toBe("the model");
  });

  it("names an added model by its file, not by its slug", () => {
    setCustomLocalModels([
      {
        id: "custom-unsloth-qwen3-4b-gguf-qwen3-4b-ud-q4_k_xl",
        name: "unsloth/Qwen3-4B-GGUF · Qwen3-4B-UD-Q4_K_XL.gguf",
        filename: "Qwen3-4B-UD-Q4_K_XL.gguf",
        huggingFaceUrl: "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/x.gguf",
        fileSizeGb: 2.4,
        sizeLabel: "2.4 GB",
        description: "Added from huggingface.co/unsloth/Qwen3-4B-GGUF",
        maxContextLength: 0,
        contextLabel: "auto",
        minRamGb: 3,
        recommendedRamGb: 6,
        family: "custom",
        supportsVision: false,
      },
    ]);
    expect(
      describeDownloadingModel("custom-unsloth-qwen3-4b-gguf-qwen3-4b-ud-q4_k_xl"),
    ).toBe("Qwen3-4B-UD-Q4_K_XL");
    setCustomLocalModels([]);
  });
});
