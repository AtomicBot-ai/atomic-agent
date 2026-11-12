import { describe, expect, it } from "vitest";

import { PROVIDER_PRESETS } from "../presets/provider-presets.js";
import {
  MODELS_DEV_PROVIDER_FOR_PRESET,
  MODELS_DEV_PROVIDER_IDS,
  modelsDevModelIdCandidates,
  modelsDevProviderFor,
} from "./models-dev-ids.js";
import { MODELS_DEV_SNAPSHOT } from "./models-dev-snapshot.js";

const preset = (id: string, baseUrl?: string) => ({
  id,
  kind: "openai-compatible",
  ...(baseUrl === undefined ? {} : { baseUrl }),
});

describe("modelsDevProviderFor", () => {
  it("maps preset ids whose models.dev slug differs", () => {
    expect(modelsDevProviderFor(preset("moonshot", "https://api.moonshot.ai"))).toBe("moonshotai");
    expect(modelsDevProviderFor(preset("fireworks", "https://api.fireworks.ai/inference"))).toBe("fireworks-ai");
    expect(modelsDevProviderFor(preset("together", "https://api.together.xyz"))).toBe("togetherai");
    expect(modelsDevProviderFor(preset("dashscope"))).toBe("alibaba");
    expect(modelsDevProviderFor(preset("novita"))).toBe("novita-ai");
  });

  it("keeps the numbered suffix a second key gets", () => {
    expect(modelsDevProviderFor(preset("groq-2", "https://api.groq.com/openai"))).toBe("groq");
  });

  it("does not price a preset id that points at another host", () => {
    expect(modelsDevProviderFor(preset("groq", "https://my-proxy.example/v1"))).toBeUndefined();
  });

  it("finds the service by host for an entry under its own id", () => {
    expect(modelsDevProviderFor(preset("kimi-direct", "https://api.moonshot.ai/v1"))).toBe("moonshotai");
    expect(modelsDevProviderFor(preset("my-endpoint", "https://llm.example.com/v1"))).toBeUndefined();
  });

  it("maps the gemini kind and leaves local servers and aggregators alone", () => {
    expect(modelsDevProviderFor({ id: "gemini", kind: "gemini" })).toBe("google");
    expect(modelsDevProviderFor(preset("ollama", "http://localhost:11434"))).toBeUndefined();
    expect(modelsDevProviderFor(preset("lmstudio", "http://localhost:1234"))).toBeUndefined();
    expect(modelsDevProviderFor({ id: "openrouter", kind: "openrouter" })).toBeUndefined();
    expect(modelsDevProviderFor({ id: "local", kind: "llama-server", url: "http://127.0.0.1:8080" })).toBeUndefined();
  });
});

describe("the mapping table", () => {
  it("names only presets that exist", () => {
    const ids = new Set(PROVIDER_PRESETS.map((p) => p.id));
    for (const presetId of Object.keys(MODELS_DEV_PROVIDER_FOR_PRESET)) {
      expect(ids.has(presetId), presetId).toBe(true);
    }
  });

  it("is what the bundled snapshot carries", () => {
    for (const slug of MODELS_DEV_PROVIDER_IDS) {
      expect(Object.keys(MODELS_DEV_SNAPSHOT[slug] ?? {}).length, slug).toBeGreaterThan(0);
    }
    expect(Object.keys(MODELS_DEV_SNAPSHOT).sort()).toEqual([...MODELS_DEV_PROVIDER_IDS]);
  });
});

describe("modelsDevModelIdCandidates", () => {
  it("tries the id as is, then without Gemini's models/ prefix", () => {
    expect(modelsDevModelIdCandidates("kimi-k3.1-pro")).toEqual(["kimi-k3.1-pro"]);
    expect(modelsDevModelIdCandidates("models/gemini-2.5-flash")).toEqual([
      "models/gemini-2.5-flash",
      "gemini-2.5-flash",
    ]);
  });
});
