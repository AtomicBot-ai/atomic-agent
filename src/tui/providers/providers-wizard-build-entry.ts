import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
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

export function providerIdForKind(
  kind: ProvidersWizardKind,
  presetId?: string | null,
): string {
  if (kind === "openrouter") return "openrouter";
  if (kind === "aimlapi") return "aimlapi";
  // A preset keeps its own id (`groq`, `nous`, …) so several presets can
  // coexist instead of overwriting one shared `openai-compatible` entry
  // (#69). Hand-typed endpoints keep the generic id as before.
  if (presetId && presetId.length > 0) return presetId;
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
  /** Set when the entry came from a known-service preset (#69). */
  presetId?: string | null;
}): BuiltWizardProvider {
  const id = providerIdForKind(input.kind, input.presetId);
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
            normalizeOpenAiBaseUrl(input.baseUrl ?? "") ||
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
