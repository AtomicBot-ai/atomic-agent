import { getConfig } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import {
  setActiveTextProviderInConfig,
  upsertLlmProvider,
  writeProviderApiKeyToDotenv,
} from "../persist-llm-provider.js";
import {
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENROUTER_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import {
  buildProviderEntryFromWizard,
  providerIdForKind,
  type BuiltWizardProvider,
} from "./providers-wizard-build-entry.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

export function saveProviderWizardToConfig(
  wizard: ProvidersWizardState,
): BuiltWizardProvider {
  const kind = wizard.kind;
  if (!kind) {
    throw new Error("wizard kind is missing");
  }

  const built = buildProviderEntryFromWizard({
    kind,
    chatModelId: wizard.selectedChatModelId ?? OPENROUTER_DEFAULT_CHAT_MODEL,
    embeddingChoiceId:
      wizard.selectedEmbeddingChoiceId ?? LOCAL_EMBEDDING_CHOICE_ID,
    baseUrl: wizard.baseUrlLine,
    customChatModel: wizard.chatModelLine,
    customEmbeddingModel: wizard.embeddingModelLine,
  });

  const existing = getConfig().llm?.providers.find(
    (provider) => provider.id === providerIdForKind(kind),
  );
  let entry = built.entry;
  if (wizard.apiKeyBuffer.trim().length > 0) {
    writeProviderApiKeyToDotenv(kind, wizard.apiKeyBuffer);
  } else if (
    !resolveLlmProviderApiKey(entry) &&
    (!existing || !resolveLlmProviderApiKey(existing))
  ) {
    throw new Error("API key is empty — paste a key or set it in .env first");
  } else if (existing?.apiKey) {
    entry = { ...entry, apiKey: existing.apiKey };
  }

  upsertLlmProvider(entry, {
    activateEmbeddingProviderId: built.activateEmbeddingProviderId,
  });
  setActiveTextProviderInConfig(entry.id);

  return { ...built, entry };
}
