import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig, resetConfigCache } from "../../config/index.js";
import { LOCAL_EMBEDDING_CHOICE_ID } from "./providers-model-options.js";
import { saveProviderWizardToConfig } from "./save-provider-wizard.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";

describe("saveProviderWizardToConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "provider-wizard-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AIMLAPI_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_API_KEY;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AIMLAPI_API_KEY;
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_API_KEY;
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
      phase: "embedding_model_line" as const,
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
        baseUrl: "https://api.venice.ai/api/",
        defaultChatModel: "venice-uncensored",
      });
  });
});
