import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeSyntheticGguf } from "./gguf-metadata.fixtures.js";
import {
  loadModelSamplingDefaults,
  mergeSampling,
  readModelSamplingDefaults,
  resetModelSamplingCache,
  sameSampling,
  samplingFromGenerationConfig,
  samplingFromGgufKeys,
} from "./gguf-sampling.js";

describe("samplingFromGgufKeys (ATO-2202)", () => {
  it("reads llama.cpp's general.sampling.* keys", () => {
    expect(
      samplingFromGgufKeys({
        "general.architecture": "qwen35",
        "general.sampling.temp": 0.6,
        "general.sampling.top_p": 0.95,
        "general.sampling.top_k": 20,
        "general.sampling.min_p": 0,
        "general.sampling.penalty_repeat": 1.05,
        "general.sampling.penalty_last_n": 64,
      }),
    ).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
      repeatPenalty: 1.05,
      repeatLastN: 64,
    });
  });

  it("is empty for a header without sampling keys", () => {
    expect(samplingFromGgufKeys({ "general.architecture": "llama" })).toEqual({});
  });

  it("drops values outside the range llama.cpp takes", () => {
    expect(
      samplingFromGgufKeys({
        "general.sampling.temp": 50,
        "general.sampling.top_p": -1,
        "general.sampling.top_k": 2.5,
        "general.sampling.min_p": "0.1",
      }),
    ).toEqual({});
  });
});

describe("samplingFromGenerationConfig (ATO-2202)", () => {
  it("maps transformers' field names", () => {
    expect(
      samplingFromGenerationConfig({
        do_sample: true,
        temperature: 1.0,
        top_p: 0.95,
        top_k: 64,
        repetition_penalty: 1.0,
        eos_token_id: [1, 106],
      }),
    ).toEqual({ temperature: 1, topP: 0.95, topK: 64, repeatPenalty: 1 });
  });

  it("takes nothing from a greedy config", () => {
    expect(
      samplingFromGenerationConfig({ do_sample: false, temperature: 0.7 }),
    ).toEqual({});
  });

  it("takes nothing from a value that is not an object", () => {
    expect(samplingFromGenerationConfig([1, 2])).toEqual({});
    expect(samplingFromGenerationConfig(null)).toEqual({});
  });
});

describe("mergeSampling / sameSampling", () => {
  it("lets the primary source win field by field", () => {
    expect(
      mergeSampling({ temperature: 0.6 }, { temperature: 1, topK: 40 }),
    ).toEqual({ temperature: 0.6, topK: 40 });
    expect(mergeSampling({}, {})).toBeNull();
  });

  it("compares by value", () => {
    expect(sameSampling({ topK: 20 }, { topK: 20 })).toBe(true);
    expect(sameSampling({ topK: 20 }, undefined)).toBe(false);
    expect(sameSampling(undefined, undefined)).toBe(true);
  });
});

describe("loadModelSamplingDefaults on real files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gguf-sampling-"));
    resetModelSamplingCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the header, rounding FLOAT32 back to the written value", async () => {
    const path = join(dir, "model.gguf");
    writeFileSync(
      path,
      encodeSyntheticGguf({
        "general.architecture": "qwen35",
        "general.sampling.temp": 0.6,
        "general.sampling.top_p": 0.95,
        "general.sampling.top_k": 20,
      }),
    );
    expect(await loadModelSamplingDefaults(path)).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
    });
  });

  it("fills what the header left out from a sibling generation_config.json", async () => {
    const path = join(dir, "model.gguf");
    writeFileSync(
      path,
      encodeSyntheticGguf({
        "general.architecture": "gemma4",
        "general.sampling.temp": 0.7,
      }),
    );
    writeFileSync(
      join(dir, "generation_config.json"),
      JSON.stringify({ temperature: 1.0, top_p: 0.95, top_k: 64 }),
    );
    expect(await readModelSamplingDefaults(path)).toEqual({
      temperature: 0.7,
      topP: 0.95,
      topK: 64,
    });
  });

  it("is null when nothing names a sampling value", async () => {
    const path = join(dir, "model.gguf");
    writeFileSync(path, encodeSyntheticGguf({ "general.architecture": "llama" }));
    writeFileSync(join(dir, "generation_config.json"), "not json");
    expect(await loadModelSamplingDefaults(path)).toBeNull();
  });

  it("is null for a path that does not exist", async () => {
    expect(await readModelSamplingDefaults(join(dir, "missing.gguf"))).toBeNull();
  });
});
