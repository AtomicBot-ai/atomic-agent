import { describe, expect, it } from "vitest";
import { LOCAL_EMBEDDING_CHOICE_ID } from "./providers-model-options.js";
import { buildProviderEntryFromWizard } from "./providers-wizard-build-entry.js";

describe("buildProviderEntryFromWizard", () => {
  it("builds OpenRouter entry with cloud embedding", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openrouter",
      chatModelId: "openrouter/auto",
      embeddingChoiceId: "openai/text-embedding-3-small",
    });
    expect(built.entry.id).toBe("openrouter");
    expect(built.entry.defaultChatModel).toBe("openrouter/auto");
    expect(built.entry.defaultEmbeddingModel).toBe(
      "openai/text-embedding-3-small",
    );
    expect(built.activateEmbeddingProviderId).toBe("openrouter");
    expect(built.useLocalEmbedding).toBe(false);
  });

  it("keeps embeddings on local llama when sentinel is chosen", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openrouter",
      chatModelId: "qwen/qwen3-30b-a3b-instruct-2507",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    });
    expect(built.entry.defaultEmbeddingModel).toBeUndefined();
    expect(built.activateEmbeddingProviderId).toBe("local-llama");
    expect(built.useLocalEmbedding).toBe(true);
  });

  it("builds an aimlapi entry with cloud embedding", () => {
    const built = buildProviderEntryFromWizard({
      kind: "aimlapi",
      chatModelId: "openai/gpt-5-2",
      embeddingChoiceId: "text-embedding-3-small",
    });
    expect(built.entry.id).toBe("aimlapi");
    expect(built.entry.kind).toBe("aimlapi");
    expect(built.entry.defaultChatModel).toBe("openai/gpt-5-2");
    expect(built.entry.defaultEmbeddingModel).toBe("text-embedding-3-small");
    expect(built.activateEmbeddingProviderId).toBe("aimlapi");
    expect(built.useLocalEmbedding).toBe(false);
  });

  it("keeps embeddings on local llama for aimlapi when sentinel is chosen", () => {
    const built = buildProviderEntryFromWizard({
      kind: "aimlapi",
      chatModelId: "openai/gpt-5-2",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    });
    expect(built.entry.defaultEmbeddingModel).toBeUndefined();
    expect(built.activateEmbeddingProviderId).toBe("local-llama");
    expect(built.useLocalEmbedding).toBe(true);
  });

  it("builds a usable Gemini entry without a manual base URL", () => {
    const built = buildProviderEntryFromWizard({
      kind: "gemini",
      chatModelId: "",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
    });

    expect(built.entry).toEqual({
      id: "gemini",
      kind: "gemini",
      defaultChatModel: "gemini-2.5-flash",
    });
    expect(built.useLocalEmbedding).toBe(true);
  });

  it("builds OpenAI-compatible entry with API root base URL", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      chatModelId: "openrouter/auto",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
      customChatModel: "gpt-5.4-mini",
    });

    expect(built.entry).toMatchObject({
      id: "openai-compatible",
      kind: "openai-compatible",
      baseUrl: "https://api.openai.com",
      defaultChatModel: "gpt-5.4-mini",
    });
    expect(built.entry.apiKeyEnvVar).toBeUndefined();
  });

  it("stamps a preset entry with the service's own env var", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      presetId: "groq",
      chatModelId: "",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
      baseUrl: "https://api.groq.com/openai",
      customChatModel: "llama-3.3-70b-versatile",
    });

    expect(built.entry).toMatchObject({
      id: "groq",
      kind: "openai-compatible",
      apiKeyEnvVar: "GROQ_API_KEY",
    });
  });

  it("gives a second entry for the same service a numbered id", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      presetId: "groq",
      takenProviderIds: ["local-llama", "groq"],
      chatModelId: "",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
      baseUrl: "https://api.groq.com/openai",
      customChatModel: "llama-3.3-70b-versatile",
    });

    // Both entries stay in config: the second one gets `groq-2` instead
    // of silently replacing the first.
    expect(built.entry.id).toBe("groq-2");
    expect(built.activateEmbeddingProviderId).toBe("local-llama");
  });

  it("keeps the existing id when reconfiguring", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      presetId: "groq",
      existingProviderId: "groq",
      takenProviderIds: ["local-llama", "groq"],
      chatModelId: "",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
      baseUrl: "https://api.groq.com/openai",
      customChatModel: "llama-3.3-70b-versatile",
    });

    // Reconfigure updates `groq` in place — no `groq-2`, and no
    // `openai-compatible` duplicate.
    expect(built.entry.id).toBe("groq");
  });

  it("keeps a hand-added entry id when reconfiguring without a preset", () => {
    const built = buildProviderEntryFromWizard({
      kind: "openai-compatible",
      existingProviderId: "my-vllm",
      chatModelId: "",
      embeddingChoiceId: LOCAL_EMBEDDING_CHOICE_ID,
      baseUrl: "http://192.168.1.50:8000",
      customChatModel: "qwen3-30b",
    });

    expect(built.entry.id).toBe("my-vllm");
    expect(built.entry.apiKeyEnvVar).toBeUndefined();
  });

  it("maps the claude-cli row onto a keyless subscription-cli entry", () => {
    const built = buildProviderEntryFromWizard({
      kind: "claude-cli",
      chatModelId: "",
      embeddingChoiceId: "",
      customChatModel: "opus",
    });
    expect(built.entry).toEqual({
      id: "claude-cli",
      kind: "subscription-cli",
      defaultChatModel: "opus",
      subscriptionCli: { cli: "claude" },
    });
    // No endpoint and no env var: the CLI authenticates itself, and a
    // stray apiKeyEnvVar would make resolveLlmProviderApiKey look for a
    // key that is never meant to exist.
    expect(built.entry.baseUrl).toBeUndefined();
    expect(built.entry.apiKeyEnvVar).toBeUndefined();
    // There is no embedding endpoint behind the CLI.
    expect(built.useLocalEmbedding).toBe(true);
    expect(built.activateEmbeddingProviderId).toBe("local-llama");
  });

  it("falls back to the default model when nothing was typed", () => {
    const built = buildProviderEntryFromWizard({
      kind: "claude-cli",
      chatModelId: "",
      embeddingChoiceId: "",
      customChatModel: "   ",
    });
    expect(built.entry.defaultChatModel).toBe("sonnet");
  });

  it("omits defaultChatModel for codex, which resolves the model itself", () => {
    const built = buildProviderEntryFromWizard({
      kind: "codex-cli",
      chatModelId: "",
      embeddingChoiceId: "",
      customChatModel: "",
    });
    expect(built.entry).toEqual({
      id: "codex-cli",
      kind: "subscription-cli",
      subscriptionCli: { cli: "codex" },
    });
    // Writing "" would fail config validation (parseOptionalString
    // rejects the empty string), and any pinned id is rejected by Codex
    // under a ChatGPT login.
    expect(built.entry.defaultChatModel).toBeUndefined();
  });

});
