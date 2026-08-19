import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
import {
  findProviderPreset,
  suggestPresetEntryId,
} from "./provider-presets.js";
import {
  GEMINI_DEFAULT_CHAT_MODEL,
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import {
  subscriptionCliForWizardKind,
  type ProvidersWizardKind,
} from "./providers-wizard-state.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";
import { CLAUDE_CLI_DEFAULT_CHAT_MODEL } from "../../llm/provider/subscription-cli/claude-cli-models.js";

export type BuiltWizardProvider = {
  entry: UserLlmProviderEntry;
  /** When set, embedding stays on local llama; do not set `defaultEmbeddingModel`. */
  useLocalEmbedding: boolean;
  /** Optional: activate this provider for embeddings after save. */
  activateEmbeddingProviderId: string | null;
};

/** The fixed entry id each wizard kind maps to when no preset is involved. */
function baseIdForKind(kind: ProvidersWizardKind): string {
  if (kind === "claude-cli") return "claude-cli";
  if (kind === "openrouter") return "openrouter";
  if (kind === "aimlapi") return "aimlapi";
  if (kind === "gemini") return "gemini";
  return "openai-compatible";
}

/**
 * Entry id for a wizard save.
 *
 * Reconfiguring keeps the existing id, whatever it is: opening `groq`
 * (or a hand-added `my-vllm`) and changing the model must update that
 * entry, not mint an `openai-compatible` duplicate and switch the
 * active provider to it.
 *
 * Adding a preset picks the first free id for its service (`groq`,
 * `groq-2`, ...), so a second entry for the same service coexists with
 * the first instead of overwriting it (#69).
 */
function providerIdForWizardSave(input: {
  kind: ProvidersWizardKind;
  presetId?: string | null;
  existingProviderId?: string | null;
  takenProviderIds?: readonly string[];
}): string {
  if (input.existingProviderId && input.existingProviderId.length > 0) {
    return input.existingProviderId;
  }
  const preset = input.presetId ? findProviderPreset(input.presetId) : undefined;
  if (preset) {
    return suggestPresetEntryId(preset, input.takenProviderIds ?? []);
  }
  return baseIdForKind(input.kind);
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
  /** Entry being reconfigured; its id is reused verbatim. */
  existingProviderId?: string | null;
  /** Ids already in config, so an added preset picks a free one. */
  takenProviderIds?: readonly string[];
}): BuiltWizardProvider {
  const id = providerIdForWizardSave(input);
  const subscriptionCli = subscriptionCliForWizardKind(input.kind);
  if (subscriptionCli) {
    // Several wizard rows, one config kind: the CLI name is the only
    // thing that differs, and it rides in the entry rather than in the
    // kind so a new vendor CLI never needs a new provider kind.
    return {
      entry: {
        id,
        kind: SUBSCRIPTION_CLI_KIND,
        defaultChatModel:
          input.customChatModel?.trim() || CLAUDE_CLI_DEFAULT_CHAT_MODEL,
        subscriptionCli: { cli: subscriptionCli },
      },
      // No embedding endpoint exists behind these CLIs, so notes keep
      // being embedded by the local daemon.
      useLocalEmbedding: true,
      activateEmbeddingProviderId: "local-llama",
    };
  }
  const preset = input.presetId ? findProviderPreset(input.presetId) : undefined;
  const chatModel = isCuratedCatalogKind(input.kind)
    ? input.chatModelId
    : (input.customChatModel?.trim() ||
      (input.kind === "gemini"
        ? GEMINI_DEFAULT_CHAT_MODEL
        : OPENAI_COMPAT_DEFAULT_CHAT_MODEL));
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
    // The preset's own env var rides on the entry, so two services never
    // resolve one shared key (see `resolveLlmProviderApiKey`).
    ...(input.kind === "openai-compatible" && preset
      ? { apiKeyEnvVar: preset.envVar }
      : {}),
  };

  return {
    entry,
    useLocalEmbedding: useLocal,
    activateEmbeddingProviderId: useLocal ? "local-llama" : id,
  };
}
