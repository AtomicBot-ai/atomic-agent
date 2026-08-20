import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLlmProviderEntry } from "../../config/llm-config.js";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { getProviderFactory } from "../../llm/provider/registry/provider-types.js";
import { registerBuiltInProviderKinds } from "../../llm/provider/registry/register-built-in-providers.js";
import {
  findProviderPreset,
  presetForEntryId,
  PROVIDER_PRESETS,
  suggestPresetEntryId,
} from "./provider-presets.js";
import { buildProviderEntryFromWizard } from "./providers-wizard-build-entry.js";

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

  it("declares the header contract for the one non-Bearer service", () => {
    // `api.anthropic.com` reads `Authorization: Bearer` as an OAuth
    // token — an `sk-ant-…` key sent that way is rejected with "Invalid
    // bearer token" on every path. Only `x-api-key` reaches the real key
    // check, and `anthropic-version` is mandatory on every request.
    expect(findProviderPreset("anthropic")?.apiKeyHeader).toBe("x-api-key");
    expect(findProviderPreset("anthropic")?.headers).toEqual({
      "anthropic-version": "2023-06-01",
    });
  });

  it("leaves every other preset on the OpenAI Bearer convention", () => {
    // The override is opt-in per service; a stray one would silently
    // break a vendor that only accepts Bearer.
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === "anthropic") continue;
      expect(preset.apiKeyHeader, preset.id).toBeUndefined();
      expect(preset.headers, preset.id).toBeUndefined();
    }
  });

  it("names every hosted vendor preset after its own service", () => {
    // Each of these answers `<baseUrl>/v1/models` — 200 with a `data`
    // array, or a 401 that rejects the *key* rather than naming a header
    // we do not send — while the same host 404s a bogus sibling path.
    // See the admission bar in `provider-presets.ts`.
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

/**
 * The blocker this suite exists for. Asserting `baseUrl` and `envVar`
 * string equality — which is all this file used to do for Anthropic —
 * cannot see that the preset resolves to a kind whose only auth mode is
 * `Authorization: Bearer`, which `api.anthropic.com` never accepts for an
 * API key. These tests pin the bytes that actually leave the process, on
 * both request paths, after the entry has been through `config.json`.
 */
describe("Anthropic preset — outgoing request headers", () => {
  const KEY = "sk-ant-test-not-a-real-key";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The saved entry, exactly as it looks after a wizard save + restart. */
  function entryAfterRestart() {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      presetId: "anthropic",
      chatModelId: "",
      embeddingChoiceId: "local",
      customChatModel: "claude-opus-4-5",
      baseUrl: findProviderPreset("anthropic")!.baseUrl,
    });
    // Round-trip through the serializer/parser pair that owns
    // `config.json`: a header contract the file cannot express would be
    // silently dropped here and the fix would last until restart.
    return parseLlmProviderEntry(
      JSON.parse(JSON.stringify(built.entry)) as unknown,
      "llm.providers[0]",
    );
  }

  it("survives the wizard save and the config.json round trip", () => {
    const entry = entryAfterRestart();
    expect(entry.apiKeyHeader).toBe("x-api-key");
    expect(entry.headers).toEqual({ "anthropic-version": "2023-06-01" });
    // The key itself must NOT be in the entry — it stays in the env var
    // so it never lands in a config file.
    expect(entry.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(entry.apiKey).toBeUndefined();
  });

  it("sends x-api-key and anthropic-version on model discovery", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "claude-opus-4-5" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const preset = findProviderPreset("anthropic")!;
    // Distinct host: the module-level cache is keyed by base URL, and a
    // sibling test in this run must not serve this one a cached list.
    await fetchOpenAiCompatModels("https://anthropic-discovery.invalid", KEY, preset);

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  it("sends x-api-key and anthropic-version on every chat turn", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "claude-opus-4-5",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    // Stub before constructing: OpenAiProvider captures `fetch` in its
    // constructor when no fetchImpl is injected, which is what the
    // registry factory does in production.
    vi.stubGlobal("fetch", fetchMock);

    registerBuiltInProviderKinds();
    const factory = getProviderFactory("openai-compatible");
    expect(factory).toBeDefined();
    const provider = await factory!({
      entry: { ...entryAfterRestart(), apiKey: KEY },
      config: {} as never,
      logger: {} as never,
    });

    await provider.complete({ prompt: "hi" });

    const sent = new Headers(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as HeadersInit,
    );
    expect(sent.get("x-api-key")).toBe(KEY);
    expect(sent.get("anthropic-version")).toBe("2023-06-01");
    expect(sent.get("authorization")).toBeNull();
  });
});
