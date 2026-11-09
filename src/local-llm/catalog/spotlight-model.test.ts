import { describe, expect, it } from "vitest";

import {
  LOCAL_MODELS_CATALOG,
  type LocalModelDef,
  type LocalModelId,
} from "./models-catalog.js";
import { spotlightModelFor } from "./spotlight-model.js";

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
    spotlight: true,
    ...extra,
  };
}

const nothingDownloaded = (): boolean => false;

describe("spotlightModelFor", () => {
  it("promotes nothing from the shipped catalog between launches", () => {
    expect(LOCAL_MODELS_CATALOG.filter((m) => m.spotlight)).toEqual([]);
    expect(spotlightModelFor(LOCAL_MODELS_CATALOG, 512, nothingDownloaded)).toBeNull();
  });

  it("ignores entries that are not marked", () => {
    const models = [def("plain", 8, { spotlight: undefined })];
    expect(spotlightModelFor(models, 32, nothingDownloaded)).toBeNull();
  });

  it("picks the largest entry that fits the memory", () => {
    const models = [def("small", 8), def("large", 32), def("too-big", 64), def("mid", 16)];
    expect(spotlightModelFor(models, 32, nothingDownloaded)?.id).toBe("large");
    expect(spotlightModelFor(models, 16, nothingDownloaded)?.id).toBe("mid");
  });

  it("takes the first in list order on a tie", () => {
    const models = [def("first", 16), def("second", 16)];
    expect(spotlightModelFor(models, 16, nothingDownloaded)?.id).toBe("first");
  });

  it("returns null when nothing fits", () => {
    expect(spotlightModelFor([def("big", 64)], 32, nothingDownloaded)).toBeNull();
  });

  it("never promotes an uncensored entry", () => {
    const models = [def("clean", 8), def("spicy", 16, { uncensored: true })];
    expect(spotlightModelFor(models, 32, nothingDownloaded)?.id).toBe("clean");
    expect(
      spotlightModelFor([def("spicy", 16, { uncensored: true })], 32, nothingDownloaded),
    ).toBeNull();
  });

  it("returns null once any spotlight entry is downloaded, even one that would not be picked", () => {
    const models = [def("small", 8), def("large", 32), def("too-big", 64)];
    expect(spotlightModelFor(models, 32, (m) => String(m.id) === "small")).toBeNull();
    expect(spotlightModelFor(models, 32, (m) => String(m.id) === "too-big")).toBeNull();
    expect(
      spotlightModelFor(
        [def("clean", 8), def("spicy", 16, { uncensored: true })],
        32,
        (m) => String(m.id) === "spicy",
      ),
    ).toBeNull();
  });

  it("does not count a downloaded model outside the spotlight", () => {
    const models = [def("new", 8), def("old", 8, { spotlight: undefined })];
    expect(spotlightModelFor(models, 32, (m) => String(m.id) === "old")?.id).toBe("new");
  });
});
