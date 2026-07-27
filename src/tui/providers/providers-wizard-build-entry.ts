import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { normalizeOpenAiCompatBaseUrl } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import {
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import type { ProvidersWizardKind } from "./providers-wizard-state.js";

export type BuiltWizardProvider = {
  entry: UserLlmProviderEntry;
  /** When set, embedding stays on local llama; do not set `defaultEmbeddingModel`. */
  useLocalEmbedding: boolean;
  /** Optional: activate this provider for embeddings after save. */
  activateEmbeddingProviderId: string | null;
};

export function providerIdForKind(kind: ProvidersWizardKind): string {
  if (kind === "openrouter") return "openrouter";
  if (kind === "aimlapi") return "aimlapi";
  return "openai-compatible";
}

function isCuratedCatalogKind(kind: ProvidersWizardKind): boolean {
  return kind === "openrouter" || kind === "aimlapi";
}

export function buildProviderEntryFromWizard(input: {
  kind: ProvidersWizardKind;
  chatModelId: string;
  embeddingChoiceId: string;
  baseUrl?: string;
  customChatModel?: string;
  customEmbeddingModel?: string;
}): BuiltWizardProvider {
  const id = providerIdForKind(input.kind);
  const chatModel = isCuratedCatalogKind(input.kind)
    ? input.chatModelId
    : (input.customChatModel?.trim() || OPENAI_COMPAT_DEFAULT_CHAT_MODEL);
  const useLocal =
    input.embeddingChoiceId === LOCAL_EMBEDDING_CHOICE_ID ||
    (input.kind === "openai-compatible" &&
      (input.customEmbeddingModel?.trim() ?? "") === "");

  let defaultEmbeddingModel: string | undefined;
  if (!useLocal) {
    defaultEmbeddingModel = isCuratedCatalogKind(input.kind)
      ? input.embeddingChoiceId
      : input.customEmbeddingModel?.trim();
  }

  const entry: UserLlmProviderEntry = {
    id,
    kind: input.kind,
    defaultChatModel: chatModel,
    ...(defaultEmbeddingModel
      ? { defaultEmbeddingModel }
      : {}),
    ...(input.kind === "openai-compatible"
      ? {
          baseUrl:
            normalizeOpenAiCompatBaseUrl(input.baseUrl ?? "") ||
            OPENAI_COMPAT_DEFAULT_BASE_URL,
        }
      : {}),
  };

  return {
    entry,
    useLocalEmbedding: useLocal,
    activateEmbeddingProviderId: useLocal ? "local-llama" : id,
  };
}
