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
});
