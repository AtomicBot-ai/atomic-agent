import { describe, expect, it } from "vitest";

import {
  findProviderPreset,
  PROVIDER_PRESETS,
  suggestPresetEntryId,
} from "./provider-presets.js";

describe("PROVIDER_PRESETS", () => {
  it("has unique ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries an absolute base URL ending in a version segment", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl)).not.toThrow();
      // Every verified endpoint serves the OpenAI surface under /v1, so
      // the stored base must already include it: the provider appends
      // paths like /chat/completions, not /v1/chat/completions.
      expect(preset.baseUrl).toMatch(/\/v1$/);
    }
  });

  it("includes the service the request came from", () => {
    // A user asked for presets and named Nous specifically (#69).
    expect(findProviderPreset("nous")).toBeDefined();
  });

  it("marks LM Studio as local", () => {
    expect(findProviderPreset("lmstudio")?.local).toBe(true);
  });

  it("only marks keyless listing where it was verified", () => {
    const keyless = PROVIDER_PRESETS.filter((p) => p.listsModelsWithoutKey).map(
      (p) => p.id,
    );
    expect(keyless).toEqual(["nous", "ollama-cloud"]);
  });

  it("returns undefined for an unknown id", () => {
    expect(findProviderPreset("nope")).toBeUndefined();
  });
});

describe("suggestPresetEntryId", () => {
  const groq = findProviderPreset("groq")!;

  it("uses the preset id when it is free", () => {
    expect(suggestPresetEntryId(groq, [])).toBe("groq");
  });

  it("numbers a second entry for the same service", () => {
    expect(suggestPresetEntryId(groq, ["groq"])).toBe("groq-2");
    expect(suggestPresetEntryId(groq, ["groq", "groq-2"])).toBe("groq-3");
  });

  it("ignores unrelated ids", () => {
    expect(suggestPresetEntryId(groq, ["nous", "openrouter"])).toBe("groq");
  });
});
