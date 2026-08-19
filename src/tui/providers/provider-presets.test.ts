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

  it("is sorted alphabetically by label", () => {
    // Array order is what the wizard renders, so keep it readable:
    // plain code-unit comparison, no locale involved.
    const labels = PROVIDER_PRESETS.map((p) => p.label);
    const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(labels).toEqual(sorted);
  });

  it("includes the service the request came from", () => {
    // A user asked for presets and named Nous specifically (#69).
    expect(findProviderPreset("nous")).toBeDefined();
  });

  it("offers Anthropic as a first-class preset", () => {
    // Claude was the one major vendor with no route into the agent at
    // all: no preset, and both aggregator catalogs filtered it out.
    // Anthropic's OpenAI-compatible endpoint needs no new provider kind.
    const preset = findProviderPreset("anthropic");
    expect(preset?.baseUrl).toBe("https://api.anthropic.com");
    expect(preset?.envVar).toBe("ANTHROPIC_API_KEY");
    expect(preset?.local).toBeUndefined();
  });

  it("names every hosted vendor preset after its own service", () => {
    // Each of these answers `<baseUrl>/v1/models` — 200 with a `data`
    // array, or 401 while the same host 404s a bogus sibling path.
    const expected: Record<string, string> = {
      anthropic: "https://api.anthropic.com",
      dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode",
      hyperbolic: "https://api.hyperbolic.xyz",
      moonshot: "https://api.moonshot.ai",
      novita: "https://api.novita.ai/openai",
      perplexity: "https://api.perplexity.ai",
      sambanova: "https://api.sambanova.ai",
    };
    for (const [id, baseUrl] of Object.entries(expected)) {
      expect(findProviderPreset(id)?.baseUrl, id).toBe(baseUrl);
    }
  });

  it("marks LM Studio as local", () => {
    expect(findProviderPreset("lmstudio")?.local).toBe(true);
  });

  it("offers local Ollama on its default port, marked local", () => {
    // `ollama serve` listens on 11434 and needs no credentials, so the
    // wizard can save the entry without a key screen. Verified against a
    // live server: GET /v1/models answers 200 with an OpenAI-shaped list.
    const preset = findProviderPreset("ollama");
    expect(preset?.local).toBe(true);
    expect(preset?.baseUrl).toBe("http://localhost:11434");
  });

  it("keeps local Ollama separate from the hosted Ollama Cloud", () => {
    // Same vendor, different services: one is the operator's own machine
    // with no key, the other is a hosted endpoint keyed by its own var.
    const local = findProviderPreset("ollama");
    const cloud = findProviderPreset("ollama-cloud");
    expect(local?.baseUrl).not.toBe(cloud?.baseUrl);
    expect(local?.envVar).not.toBe(cloud?.envVar);
    expect(cloud?.local).toBeUndefined();
    // The `-\d+` suffix rule must not turn the hosted id into the local
    // preset: `ollama` is a prefix of `ollama-cloud`.
    expect(presetForEntryId("ollama-cloud")?.id).toBe("ollama-cloud");
    expect(presetForEntryId("ollama-2")?.id).toBe("ollama");
  });

  it("keeps the verified keyless-listing services marked", () => {
    // Presence checks, not an exact list: a new keyless preset must not
    // break this test, it only has to keep the verified ones flagged.
    const keyless = PROVIDER_PRESETS.filter((p) => p.listsModelsWithoutKey).map(
      (p) => p.id,
    );
    expect(keyless).toContain("nous");
    expect(keyless).toContain("ollama-cloud");
    expect(keyless).toContain("novita");
    expect(keyless).toContain("sambanova");
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
