import { getConfig } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import {
  setActiveTextProviderInConfig,
  upsertLlmProvider,
  writeProviderApiKeyToDotenv,
} from "../persist-llm-provider.js";
import { findProviderPreset } from "./provider-presets.js";
import {
  AIMLAPI_DEFAULT_CHAT_MODEL,
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENROUTER_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import {
  buildProviderEntryFromWizard,
  type BuiltWizardProvider,
} from "./providers-wizard-build-entry.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

function defaultChatModelForKind(kind: ProvidersWizardKind): string {
  if (kind === "aimlapi") return AIMLAPI_DEFAULT_CHAT_MODEL;
  return OPENROUTER_DEFAULT_CHAT_MODEL;
}

export function saveProviderWizardToConfig(
  wizard: ProvidersWizardState,
): BuiltWizardProvider {
  const kind = wizard.kind;
  if (!kind) {
    throw new Error("wizard kind is missing");
  }

  const providers = getConfig().llm?.providers ?? [];
  const built = buildProviderEntryFromWizard({
    kind,
    presetId: wizard.presetId,
    existingProviderId: wizard.mode === "configure" ? wizard.providerId : null,
    takenProviderIds: providers.map((provider) => provider.id),
    chatModelId:
      wizard.selectedChatModelId ?? defaultChatModelForKind(kind),
    embeddingChoiceId:
      wizard.selectedEmbeddingChoiceId ?? LOCAL_EMBEDDING_CHOICE_ID,
    baseUrl: wizard.baseUrlLine,
    customChatModel: wizard.chatModelLine,
    customEmbeddingModel: wizard.embeddingModelLine,
  });

  const existing = providers.find(
    (provider) => provider.id === built.entry.id,
  );
  let entry = built.entry;
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  // Local servers have no key at all, and keyless-listing services work
  // before one is entered, so an empty key is a valid state for both:
  // nothing is written to .env and requests go out without Authorization.
  const keyOptional = Boolean(preset && (preset.local || preset.listsModelsWithoutKey));
  if (wizard.apiKeyBuffer.trim().length > 0) {
    writeProviderApiKeyToDotenv(kind, wizard.apiKeyBuffer, preset?.envVar);
  } else if (existing?.apiKey) {
    entry = { ...entry, apiKey: existing.apiKey };
  } else if (
    !keyOptional &&
    !resolveLlmProviderApiKey(entry) &&
    !(existing && resolveLlmProviderApiKey(existing))
  ) {
    throw new Error("API key is empty — paste a key or set it in .env first");
  }

  upsertLlmProvider(entry, {
    activateEmbeddingProviderId: built.activateEmbeddingProviderId,
  });
  setActiveTextProviderInConfig(entry.id);

  return { ...built, entry };
}
