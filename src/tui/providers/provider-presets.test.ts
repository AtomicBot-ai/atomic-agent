import { describe, expect, it } from "vitest";

import {
  findProviderPreset,
  presetForEntryId,
  PROVIDER_PRESETS,
  suggestPresetEntryId,
} from "./provider-presets.js";

describe("PROVIDER_PRESETS", () => {
  it("has unique ids", () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stores API roots without the /v1 suffix, like every compat base URL", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl)).not.toThrow();
      // Call sites append `/v1/...` themselves (openai-provider.ts), so
      // the repo stores compat base URLs without the version segment —
      // `OPENAI_COMPAT_DEFAULT_BASE_URL` is `https://api.openai.com`.
      // A stored `/v1` would only survive because normalization strips
      // it again; presets follow the convention instead of leaning on
      // that safety net.
      expect(preset.baseUrl).not.toMatch(/\/v1\/?$/);
      expect(preset.baseUrl).not.toMatch(/\/$/);
    }
  });

  it("includes the service the request came from", () => {
    // A user asked for presets and named Nous specifically (#69).
    expect(findProviderPreset("nous")).toBeDefined();
  });

  it("marks LM Studio as local", () => {
    expect(findProviderPreset("lmstudio")?.local).toBe(true);
  });

  it("keeps the verified keyless-listing services marked", () => {
    // Presence checks, not an exact list: a new keyless preset must not
    // break this test, it only has to keep the verified ones flagged.
    const keyless = PROVIDER_PRESETS.filter((p) => p.listsModelsWithoutKey).map(
      (p) => p.id,
    );
    expect(keyless).toContain("nous");
    expect(keyless).toContain("ollama-cloud");
    expect(keyless).toContain("orcarouter");
  });

  it("exposes OrcaRouter as a named preset", () => {
    expect(findProviderPreset("orcarouter")?.baseUrl).toBe(
      "https://api.orcarouter.ai",
    );
    expect(findProviderPreset("orcarouter")?.envVar).toBe("ORCAROUTER_API_KEY");
  });

  it("returns undefined for an unknown id", () => {
    expect(findProviderPreset("nope")).toBeUndefined();
  });
});

describe("preset env vars", () => {
  it("gives every preset its own variable", () => {
    const vars = PROVIDER_PRESETS.map((p) => p.envVar);
    expect(new Set(vars).size).toBe(vars.length);
  });

  it("never reuses the shared compat or catalog variables", () => {
    // Sharing OPENAI_COMPAT_API_KEY meant connecting a second service
    // silently overwrote the first one's key.
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.envVar).not.toBe("OPENAI_COMPAT_API_KEY");
      expect(preset.envVar).not.toBe("OPENROUTER_API_KEY");
      expect(preset.envVar).not.toBe("AIMLAPI_API_KEY");
    }
  });

  it("names variables after the service", () => {
    expect(findProviderPreset("groq")?.envVar).toBe("GROQ_API_KEY");
    expect(findProviderPreset("together")?.envVar).toBe("TOGETHER_API_KEY");
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

describe("presetForEntryId", () => {
  it("finds the preset for a plain entry id", () => {
    expect(presetForEntryId("groq")?.id).toBe("groq");
  });

  it("finds the preset behind a numbered suffix", () => {
    expect(presetForEntryId("groq-2")?.id).toBe("groq");
    expect(presetForEntryId("ollama-cloud-3")?.id).toBe("ollama-cloud");
  });

  it("returns undefined for hand-added entries", () => {
    expect(presetForEntryId("openai-compatible")).toBeUndefined();
    expect(presetForEntryId("my-vllm")).toBeUndefined();
  });
});
