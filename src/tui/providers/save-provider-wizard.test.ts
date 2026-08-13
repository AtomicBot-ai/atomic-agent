import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { LOCAL_EMBEDDING_CHOICE_ID } from "./providers-model-options.js";
import { saveProviderWizardToConfig } from "./save-provider-wizard.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "AIMLAPI_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "LMSTUDIO_API_KEY",
  "NOUS_API_KEY",
] as const;

describe("saveProviderWizardToConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "provider-wizard-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    for (const key of ENV_KEYS) delete process.env[key];
    resetConfigCache();
  });

  it("persists and activates an aimlapi text provider from onboarding", () => {
    const wizard = {
      ...createProvidersWizardState("add"),
      kind: "aimlapi" as const,
      phase: "pick_embedding" as const,
      apiKeyBuffer: "ai-test",
      selectedChatModelId: "openai/gpt-5-2",
      selectedEmbeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    };

    const built = saveProviderWizardToConfig(wizard);
    const cfg = getConfig();

    expect(built.entry.id).toBe("aimlapi");
    expect(process.env.AIMLAPI_API_KEY).toBe("ai-test");
    expect(cfg.llm?.activeTextProvider).toBe("aimlapi");
    expect(cfg.llm?.activeEmbeddingProvider).toBe("local-llama");
    expect(cfg.llm?.providers.find((p) => p.id === "aimlapi")).toMatchObject({
      kind: "aimlapi",
      defaultChatModel: "openai/gpt-5-2",
    });
  });

  it("persists and activates an OpenRouter text provider from onboarding", () => {
    const wizard = {
      ...createProvidersWizardState("add"),
      kind: "openrouter" as const,
      phase: "pick_embedding" as const,
      apiKeyBuffer: "sk-or-test",
      selectedChatModelId: "openai/gpt-5.5",
      selectedEmbeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    };

    const built = saveProviderWizardToConfig(wizard);
    const cfg = getConfig();

    expect(built.entry.id).toBe("openrouter");
    expect(process.env.OPENROUTER_API_KEY).toBe("sk-or-test");
    expect(cfg.llm?.activeTextProvider).toBe("openrouter");
    expect(cfg.llm?.activeEmbeddingProvider).toBe("local-llama");
    expect(cfg.llm?.providers.find((p) => p.id === "openrouter")).toMatchObject({
      kind: "openrouter",
      defaultChatModel: "openai/gpt-5.5",
    });
    expect(cfg.llm?.providers.some((p) => p.id === "local-llama")).toBe(true);
  });

  it("accepts an existing environment API key when the wizard key is empty", () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    const wizard = {
      ...createProvidersWizardState("add"),
      kind: "openrouter" as const,
      phase: "pick_embedding" as const,
      selectedChatModelId: "openrouter/auto",
      selectedEmbeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    };

    saveProviderWizardToConfig(wizard);

    expect(getConfig().llm?.activeTextProvider).toBe("openrouter");
  });

  it("stores OpenAI-compatible wizard keys under a neutral env name", () => {
    const wizard = {
      ...createProvidersWizardState("add"),
      kind: "openai-compatible" as const,
      phase: "chat_model_line" as const,
      apiKeyBuffer: "venice-key",
      baseUrlLine: "https://api.venice.ai/api/",
      chatModelLine: "venice-uncensored",
    };

    saveProviderWizardToConfig(wizard);

    expect(process.env.OPENAI_COMPAT_API_KEY).toBe("venice-key");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(getConfig().llm?.providers.find((p) => p.id === "openai-compatible"))
      .toMatchObject({
        kind: "openai-compatible",
        // trailing slash normalized away — callers append `/v1/...`
        baseUrl: "https://api.venice.ai/api",
        defaultChatModel: "venice-uncensored",
      });
  });

  function groqWizard(apiKey: string) {
    return {
      ...createProvidersWizardState("add"),
      kind: "openai-compatible" as const,
      presetId: "groq",
      phase: "chat_model_line" as const,
      apiKeyBuffer: apiKey,
      baseUrlLine: "https://api.groq.com/openai",
      chatModelLine: "llama-3.3-70b-versatile",
    };
  }

  it("stores a preset key under the service's own env var", () => {
    const built = saveProviderWizardToConfig(groqWizard("gsk-groq"));

    expect(built.entry.id).toBe("groq");
    expect(built.entry.apiKeyEnvVar).toBe("GROQ_API_KEY");
    expect(process.env.GROQ_API_KEY).toBe("gsk-groq");
    // The shared compat variable stays free for hand-added endpoints.
    expect(process.env.OPENAI_COMPAT_API_KEY).toBeUndefined();
  });

  it("keeps two services' keys apart", () => {
    saveProviderWizardToConfig(groqWizard("gsk-groq"));
    saveProviderWizardToConfig({
      ...createProvidersWizardState("add"),
      kind: "openai-compatible" as const,
      presetId: "nous",
      phase: "chat_model_line" as const,
      apiKeyBuffer: "nous-key",
      baseUrlLine: "https://inference-api.nousresearch.com",
      chatModelLine: "hermes-4-405b",
    });

    // Adding Nous must not overwrite the Groq key (#69's failure mode).
    expect(process.env.GROQ_API_KEY).toBe("gsk-groq");
    expect(process.env.NOUS_API_KEY).toBe("nous-key");
  });

  it("updates the live environment when a key is replaced mid-session", () => {
    saveProviderWizardToConfig(groqWizard("gsk-old"));
    saveProviderWizardToConfig({
      ...groqWizard("gsk-new"),
      mode: "configure" as const,
      providerId: "groq",
    });

    // Not only .env: the running session must resolve the new key too.
    expect(process.env.GROQ_API_KEY).toBe("gsk-new");
  });

  it("refuses an empty key for a service that requires one", () => {
    expect(() => saveProviderWizardToConfig(groqWizard(""))).toThrow(
      /API key is empty/,
    );
  });

  it("saves LM Studio without any key", () => {
    const built = saveProviderWizardToConfig({
      ...createProvidersWizardState("add"),
      kind: "openai-compatible" as const,
      presetId: "lmstudio",
      phase: "chat_model_line" as const,
      apiKeyBuffer: "",
      baseUrlLine: "http://localhost:1234",
      chatModelLine: "qwen3-30b",
    });

    expect(built.entry.id).toBe("lmstudio");
    // Empty key is the valid state for a local server: nothing lands in
    // the environment and the entry stores no key either.
    expect(process.env.LMSTUDIO_API_KEY).toBeUndefined();
    expect(built.entry.apiKey).toBeUndefined();
    expect(getConfig().llm?.activeTextProvider).toBe("lmstudio");
  });

  it("gives a second entry for the same service a numbered id", () => {
    saveProviderWizardToConfig(groqWizard("gsk-groq"));
    const second = saveProviderWizardToConfig({
      ...groqWizard(""),
      chatModelLine: "qwen-qwq-32b",
    });

    // The service key is already in the environment, so the second
    // entry saves without retyping it — and lands next to the first
    // entry instead of on top of it.
    expect(second.entry.id).toBe("groq-2");
    const providers = getConfig().llm?.providers ?? [];
    expect(providers.find((p) => p.id === "groq")).toMatchObject({
      defaultChatModel: "llama-3.3-70b-versatile",
    });
    expect(providers.find((p) => p.id === "groq-2")).toMatchObject({
      defaultChatModel: "qwen-qwq-32b",
      apiKeyEnvVar: "GROQ_API_KEY",
    });
  });

  it("reconfigure keeps the entry id instead of minting a duplicate", () => {
    saveProviderWizardToConfig(groqWizard("gsk-groq"));

    const built = saveProviderWizardToConfig({
      ...createProvidersWizardState("configure", {
        providerId: "groq",
        kind: "openai-compatible",
        baseUrl: "https://api.groq.com/openai",
      }),
      phase: "chat_model_line" as const,
      chatModelLine: "qwen-qwq-32b",
    });

    expect(built.entry.id).toBe("groq");
    const providers = getConfig().llm?.providers ?? [];
    expect(providers.filter((p) => p.kind === "openai-compatible")).toHaveLength(1);
    expect(providers.find((p) => p.id === "groq")).toMatchObject({
      defaultChatModel: "qwen-qwq-32b",
      apiKeyEnvVar: "GROQ_API_KEY",
    });
    // The active provider still points at the same id — no duplicate
    // stole the selection.
    expect(getConfig().llm?.activeTextProvider).toBe("groq");
  });
});
