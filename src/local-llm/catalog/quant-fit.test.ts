import { describe, expect, it } from "vitest";

import type { MachineForModels } from "./model-upgrade.js";
import {
  activeShareFromName,
  forecastDecodeSpeed,
  formatSpeedEstimate,
  pickBestQuant,
  quantBitsFromName,
  quantFitFor,
  rateQuant,
} from "./quant-fit.js";

const GB = 1_000_000_000;

/** A 32 GB M2 Pro: 24 GB GPU budget, 200 GB/s shared. */
const MAC: MachineForModels = {
  ramGb: 32,
  gpuBudgetGb: 24,
  freeDiskGb: 200,
  cpuOnly: false,
  bandwidth: { gpuGbPerSec: 200, ramGbPerSec: 200, unified: true },
};

/** 32 GB of RAM and an 8 GB RTX 4060. */
const PC: MachineForModels = {
  ramGb: 32,
  gpuBudgetGb: 8,
  freeDiskGb: 200,
  cpuOnly: false,
  bandwidth: { gpuGbPerSec: 272, ramGbPerSec: 50, unified: false },
};

const CPU_ONLY: MachineForModels = {
  ramGb: 16,
  gpuBudgetGb: null,
  freeDiskGb: 200,
  cpuOnly: true,
  bandwidth: { gpuGbPerSec: null, ramGbPerSec: 50, unified: false },
};

describe("quantBitsFromName", () => {
  const rows: [string, number | null][] = [
    ["Qwen3.5-4B-Q4_K_M.gguf", 4],
    ["Qwen3.5-4B-UD-Q4_K_XL.gguf", 4],
    ["gemma-4-E4B-it-IQ3_XXS.gguf", 3],
    ["Q8_0/Qwen3.5-9B-Q8_0.gguf", 8],
    ["model-Q2_K.gguf", 2],
    ["gpt-oss-20b-MXFP4.gguf", 4],
    ["Qwen3.5-4B-BF16.gguf", 16],
    ["model.gguf", null],
  ];
  for (const [name, bits] of rows) {
    it(`reads ${name} as ${bits}`, () => expect(quantBitsFromName(name)).toBe(bits));
  }
});

describe("activeShareFromName", () => {
  it("reads a mixture-of-experts name", () => {
    expect(activeShareFromName("Qwen3.6-35B-A3B-Q4_K_M.gguf")).toBeCloseTo(3 / 35);
    expect(activeShareFromName("gemma-4-26b-a4b")).toBeCloseTo(4 / 26);
  });

  it("assumes a dense model when the name does not say", () => {
    expect(activeShareFromName("Qwen3.5-9B-Q4_K_M.gguf")).toBe(1);
  });
});

describe("quantFitFor", () => {
  it("fits what sits in 85% of the GPU memory", () => {
    expect(quantFitFor(6, PC)).toMatchObject({ tier: "fits", placement: "gpu", label: "Fits well" });
  });

  it("calls a spill into system RAM a tight fit", () => {
    expect(quantFitFor(12, PC)).toMatchObject({ tier: "tight", placement: "ram", label: "Tight fit" });
  });

  it("calls weights past the RAM too big", () => {
    expect(quantFitFor(40, PC)).toMatchObject({ tier: "too-big", placement: "disk", label: "Too big" });
  });

  it("judges a machine without a GPU by its RAM alone", () => {
    expect(quantFitFor(5, CPU_ONLY).tier).toBe("fits");
    expect(quantFitFor(11, CPU_ONLY).tier).toBe("tight");
    expect(quantFitFor(20, CPU_ONLY).tier).toBe("too-big");
  });
});

describe("forecastDecodeSpeed", () => {
  it("divides bandwidth by the bytes a token reads", () => {
    // 200 GB/s × 0.6 / 5 GB = 24; the label rounds it to 25.
    expect(forecastDecodeSpeed({ weightsGb: 5, machine: MAC })).toEqual({
      tokPerSec: 24,
      label: "~25 tok/s, estimate",
    });
  });

  it("is faster for a mixture-of-experts model of the same size", () => {
    const dense = forecastDecodeSpeed({ weightsGb: 20, machine: MAC })!;
    const moe = forecastDecodeSpeed({ weightsGb: 20, activeShare: 0.1, machine: MAC })!;
    expect(moe.tokPerSec).toBeGreaterThan(dense.tokPerSec * 3);
  });

  it("slows down sharply once the weights spill out of the GPU", () => {
    const inGpu = forecastDecodeSpeed({ weightsGb: 6, machine: PC })!;
    const spilled = forecastDecodeSpeed({ weightsGb: 12, machine: PC })!;
    expect(spilled.tokPerSec).toBeLessThan(inGpu.tokPerSec / 3);
  });

  it("reads RAM speed on a CPU-only machine", () => {
    // 50 GB/s × 0.5 / 5 GB = 5.
    expect(forecastDecodeSpeed({ weightsGb: 5, machine: CPU_ONLY })?.tokPerSec).toBe(5);
  });

  it("says nothing when the bandwidth is unknown or the model only runs from disk", () => {
    expect(forecastDecodeSpeed({ weightsGb: 5, machine: { ...MAC, bandwidth: undefined } })).toBeNull();
    expect(forecastDecodeSpeed({ weightsGb: 60, machine: PC })).toBeNull();
  });

  it("always labels the number an estimate", () => {
    expect(formatSpeedEstimate(0.4)).toBe("under 1 tok/s, estimate");
    expect(formatSpeedEstimate(7.4)).toBe("~7 tok/s, estimate");
    expect(formatSpeedEstimate(143)).toBe("~140 tok/s, estimate");
  });
});

describe("pickBestQuant", () => {
  const files = (sizes: [string, number][]) =>
    sizes.map(([path, gb]) => ({ path, sizeBytes: gb * GB }));
  const rate = (machine: MachineForModels, list: { path: string; sizeBytes: number }[]) =>
    list.map((f) => ({ ...rateQuant(f, machine), sizeBytes: f.sizeBytes }));

  const NINE_B = files([
    ["Qwen3.5-9B-Q3_K_M.gguf", 4.4],
    ["Qwen3.5-9B-Q4_K_M.gguf", 5.6],
    ["Qwen3.5-9B-Q5_K_M.gguf", 6.5],
    ["Qwen3.5-9B-Q8_0.gguf", 9.5],
  ]);

  it("takes the most precise quant that fits the GPU and still answers quickly", () => {
    // Mac (120 GB/s effective): Q8_0 at 9.5 GB is 12.6 tok/s and Q5 at 6.5 GB
    // 18.5, both under the pleasant floor; Q4_K_M at 5.6 GB, 21.4, is the most
    // precise above it.
    expect(NINE_B[pickBestQuant(rate(MAC, NINE_B))!]!.path).toBe("Qwen3.5-9B-Q4_K_M.gguf");
  });

  it("takes the most precise when all of them are fast", () => {
    const fast: MachineForModels = {
      ...MAC,
      ramGb: 128,
      gpuBudgetGb: 96,
      bandwidth: { gpuGbPerSec: 800, ramGbPerSec: 800, unified: true },
    };
    expect(NINE_B[pickBestQuant(rate(fast, NINE_B))!]!.path).toBe("Qwen3.5-9B-Q8_0.gguf");
  });

  it("never goes below 4-bit, even when only a 3-bit file fits the GPU", () => {
    const small: MachineForModels = { ...PC, gpuBudgetGb: 6 };
    const picked = pickBestQuant(rate(small, NINE_B));
    // 4.4 GB Q3 fits 6 × 0.85 = 5.1, Q4 does not: the pick is the smallest
    // 4-bit-or-more tight fit instead.
    expect(NINE_B[picked!]!.path).toBe("Qwen3.5-9B-Q4_K_M.gguf");
  });

  it("picks nothing when only files below 4-bit or past the RAM are left", () => {
    const tiny: MachineForModels = { ...CPU_ONLY, ramGb: 6 };
    expect(pickBestQuant(rate(tiny, NINE_B))).toBeNull();
  });

  it("does not pick a file whose bit level the name hides", () => {
    expect(pickBestQuant(rate(MAC, files([["model.gguf", 3]])))).toBeNull();
  });
});

describe("experts in RAM (ATO-2455)", () => {
  const QWEN_35B_A3B = 22.4;
  const share = activeShareFromName("Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf");

  it("fits a 35B-A3B on an 8 GB card with 32 GB of RAM, experts partly in RAM", () => {
    expect(quantFitFor(QWEN_35B_A3B, PC, share)).toEqual({
      tier: "fits",
      label: "Fits, experts in RAM",
      placement: "split",
    });
  });

  it("keeps the dense verdict for the same size without an MoE name", () => {
    expect(quantFitFor(QWEN_35B_A3B, PC)).toMatchObject({ tier: "tight", placement: "ram" });
  });

  it("says too big again when cpuMoe is off", () => {
    expect(quantFitFor(QWEN_35B_A3B, { ...PC, cpuMoe: "off" }, share)).toMatchObject({
      tier: "tight",
      placement: "ram",
    });
    expect(quantFitFor(QWEN_35B_A3B, { ...PC, ramGb: 24, cpuMoe: "off" }, share)).toMatchObject({
      tier: "too-big",
    });
  });

  it("turns a too-big into a tight split when the RAM holds only the experts' part", () => {
    // 24 GB: the whole 22.4 GB × 1.2 does not fit; the 15.6 GB in RAM × 1.2 does.
    expect(quantFitFor(QWEN_35B_A3B, { ...PC, ramGb: 24 }, share)).toEqual({
      tier: "tight",
      label: "Tight fit",
      placement: "split",
    });
  });

  it("leaves a Mac alone: one memory, no experts on the CPU", () => {
    expect(quantFitFor(QWEN_35B_A3B, { ...MAC, gpuBudgetGb: 16 }, share).placement).not.toBe("split");
  });

  describe("the default pick", () => {
    const QWEN_30B_A3B = [
      ["Qwen3-30B-A3B-Q4_K_M.gguf", 18.6],
      ["Qwen3-30B-A3B-Q6_K.gguf", 25.1],
      ["Qwen3-30B-A3B-Q8_0.gguf", 32.5],
    ].map(([path, gb]) => ({ path: path as string, sizeBytes: (gb as number) * GB }));
    const rate = (machine: MachineForModels) =>
      QWEN_30B_A3B.map((f) => ({ ...rateQuant(f, machine), sizeBytes: f.sizeBytes }));

    it("keeps the quant that fits the card over a more precise one with experts in RAM", () => {
      // 24 GB card: Q4_K_M (18.6 GB) fits 24 x 0.85 = 20.4 fully; Q6_K and
      // Q8_0 only fit with experts in RAM, at a much slower forecast.
      const card24: MachineForModels = {
        ramGb: 64,
        gpuBudgetGb: 24,
        freeDiskGb: 500,
        cpuOnly: false,
        bandwidth: { gpuGbPerSec: 1000, ramGbPerSec: 60, unified: false },
      };
      const rated = rate(card24);
      expect(rated[1]!.fit.placement).toBe("split");
      const picked = pickBestQuant(rated)!;
      expect(rated[picked]!.fit.placement).toBe("gpu");
      expect(QWEN_30B_A3B[picked]!.path).toBe("Qwen3-30B-A3B-Q4_K_M.gguf");
    });

    it("falls back to experts in RAM only when no quant fits fully", () => {
      const card8: MachineForModels = { ...PC, ramGb: 64 };
      const rated = rate(card8);
      const picked = pickBestQuant(rated);
      expect(picked).not.toBeNull();
      expect(rated[picked!]!.fit.placement).toBe("split");
    });
  });

  it("rates an MoE quant from its file name and forecasts a speed for it", () => {
    const rated = rateQuant({ path: "Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf", sizeBytes: QWEN_35B_A3B * GB }, PC);
    expect(rated.fit.placement).toBe("split");
    expect(rated.speed?.label).toMatch(/tok\/s, estimate$/);
    expect(rated.speed!.tokPerSec).toBeGreaterThan(5);
  });
});
