import { describe, expect, it } from "vitest";
import { parseLlmProviderEntry, type UserLlmProviderEntry } from "./llm-config.js";
import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";
import { captureModelModePolicy, resolveModelMode } from "../llm/model-mode.js";
import { PROVIDER_PRESETS } from "../llm/provider/presets/provider-presets.js";

describe("model mode configuration", () => {
  const provider = { id: "remote", kind: "openrouter", defaultChatModel: "large" };
  it.each([75, 76, undefined])("does not reclassify missing policies at version %s", version => {
    const parsed = parseUserConfigFile({ version, llm: {
      activeTextProvider: "remote", activeEmbeddingProvider: "remote", providers: [provider],
    } });
    const entry = parsed.llm!.providers[0]!;
    expect(entry).not.toHaveProperty("modelMode");
    expect(entry).not.toHaveProperty("modelModes");
    // The policy resolver needs only the explicitly typed llm block.
    expect(resolveModelMode(captureModelModePolicy({ ...parsed.llm!, providers: [...parsed.llm!.providers] })).mode).toBe("local");
  });
  it.each([66, 74])("migrates known cloud services from v%s without mutating the input", version => {
    const providers: UserLlmProviderEntry[] = [
      ...["openrouter", "aimlapi", "gemini"].map(kind => ({ id: kind, kind })),
      ...(["claude", "codex"] as const).map(cli => ({
        id: cli, kind: "subscription-cli", subscriptionCli: { cli },
      })),
      { id: "openai", kind: "openai-compatible", baseUrl: "https://API.OPENAI.COM:443/v1/" },
      ...PROVIDER_PRESETS.filter(preset => !preset.local).map(preset => ({
        id: `${preset.id}-2`, kind: "openai-compatible", baseUrl: preset.baseUrl,
      })),
    ];
    const raw = { version, llm: {
      activeTextProvider: "openrouter", activeEmbeddingProvider: "openrouter", providers,
    } };
    const original = JSON.stringify(raw);
    const parsed = parseUserConfigFile(raw);
    expect(parsed.version).toBe(USER_CONFIG_VERSION);
    expect(parsed.llm!.providers).toHaveLength(providers.length);
    for (const entry of parsed.llm!.providers) expect(entry.modelMode).toBe("cloud");
    expect(resolveModelMode(captureModelModePolicy(parsed.llm!)).mode).toBe("cloud");
    expect(JSON.stringify(raw)).toBe(original);
    expect(parseUserConfigFile(parsed)).toEqual(parsed);
  });
  it("preserves explicit policies, model overrides, local and unknown providers during migration", () => {
    const providers: UserLlmProviderEntry[] = [
      { ...provider, modelModes: { small: "local", large: "cloud" } },
      { id: "manual", kind: "gemini", modelMode: "local", modelModes: { large: "cloud" } },
      { id: "manual-cloud", kind: "llama-server", modelMode: "cloud" },
      { id: "local", kind: "llama-server", url: "http://127.0.0.1:8080" },
      ...PROVIDER_PRESETS.filter(preset => preset.local).map(preset => ({
        id: preset.id, kind: "openai-compatible", baseUrl: preset.baseUrl,
      })),
      { id: "lan", kind: "openai-compatible", baseUrl: "http://192.168.1.2:8080" },
      { id: "groq", kind: "openai-compatible", baseUrl: "https://custom.example.com" },
      { id: "lookalike", kind: "openai-compatible", baseUrl: "https://api.openai.com.example.com" },
      { id: "qwen-local", kind: "qwen-openai-compatible", baseUrl: "http://localhost:8080" },
    ];
    const llm = { activeTextProvider: "remote", activeEmbeddingProvider: "local", providers };
    const migrated = parseUserConfigFile({ version: 74, llm }).llm!;
    const unchanged = parseUserConfigFile({ version: 75, llm }).llm!;
    expect(migrated).toEqual({ ...unchanged, providers: unchanged.providers.map(entry =>
      entry.id === "remote" ? { ...entry, modelMode: "cloud" } : entry) });
    const policy = captureModelModePolicy(migrated);
    expect(resolveModelMode(policy, "remote", "small")).toMatchObject({ mode: "local", source: "model" });
    expect(resolveModelMode(policy, "remote", "other").mode).toBe("cloud");
    expect(resolveModelMode(policy, "manual", "other").mode).toBe("local");
  });
  it("treats null as absent but rejects invalid policies before migration", () => {
    const raw = (modelMode: unknown) => ({ version: 74, llm: {
      activeTextProvider: "remote", providers: [{ ...provider, modelMode }],
    } });
    expect(parseUserConfigFile(raw(null)).llm!.providers[0]!.modelMode).toBe("cloud");
    expect(() => parseUserConfigFile(raw("auto"))).toThrow(/modelMode/);
  });
  it("round-trips overrides without creating a catalog metadata override", () => {
    const parsed = parseLlmProviderEntry({ ...provider, modelMode: "cloud", modelModes: { large: "local", "vendor/model": "cloud" } }, "provider");
    expect(parseLlmProviderEntry(JSON.parse(JSON.stringify(parsed)), "provider")).toEqual(parsed);
    expect(parsed.userModels).toBeUndefined();
  });
  it.each([false, "auto", "fusion", 1, {}])("rejects invalid provider mode %j", value => {
    expect(() => parseLlmProviderEntry({ ...provider, modelMode: value }, "provider")).toThrow(/provider.modelMode/);
  });
  it.each([[], "cloud", { "": "cloud" }, { small: null }, { small: "auto" }])("rejects invalid model overrides %j", value => {
    expect(() => parseLlmProviderEntry({ ...provider, modelModes: value }, "provider")).toThrow(/provider.modelModes/);
  });
});
