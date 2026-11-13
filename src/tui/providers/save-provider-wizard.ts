import { getConfig } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import { isAsciiOnly } from "../../llm/provider/openai/ascii-header-guard.js";
import { isOtherComputerOnNetworkUrl } from "../../llm/provider/openai/network-server-address.js";
import {
  setActiveTextProviderInConfig,
  upsertLlmProvider,
  writeProviderApiKeyToDotenv,
} from "../../config/llm-provider-commands.js";
import { findProviderPreset } from "./provider-presets.js";
import { wizardKeyIsOptional } from "./providers-wizard-target.js";
import {
  AIMLAPI_DEFAULT_CHAT_MODEL,
  GEMINI_DEFAULT_CHAT_MODEL,
  LOCAL_EMBEDDING_CHOICE_ID,
  OPENROUTER_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import {
  buildProviderEntryFromWizard,
  type BuiltWizardProvider,
} from "./providers-wizard-build-entry.js";
import {
  subscriptionCliForWizardKind,
  type ProvidersWizardKind,
  type ProvidersWizardState,
} from "./providers-wizard-state.js";
import {
  registerBuiltInCliAdapters,
  resolveCliAdapter,
} from "../../llm/provider/subscription-cli/index.js";

function defaultChatModelForKind(kind: ProvidersWizardKind): string {
  const cli = subscriptionCliForWizardKind(kind);
  if (cli) {
    registerBuiltInCliAdapters();
    return resolveCliAdapter(cli).defaultChatModel;
  }
  if (kind === "aimlapi") return AIMLAPI_DEFAULT_CHAT_MODEL;
  if (kind === "gemini") return GEMINI_DEFAULT_CHAT_MODEL;
  return OPENROUTER_DEFAULT_CHAT_MODEL;
}

/** `.env` variable for the key of a server on another computer: `custom-192-168-1-20-8080` -> `ATOMIC_AGENT_KEY_CUSTOM_192_168_1_20_8080`. */
export function networkComputerKeyEnvVar(providerId: string): string {
  return `ATOMIC_AGENT_KEY_${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
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
    chatModelId: wizard.selectedChatModelId ?? defaultChatModelForKind(kind),
    embeddingChoiceId:
      wizard.selectedEmbeddingChoiceId ?? LOCAL_EMBEDDING_CHOICE_ID,
    baseUrl: wizard.baseUrlLine,
    customChatModel: wizard.chatModelLine,
    customEmbeddingModel: wizard.embeddingModelLine,
  });

  const existing = providers.find((provider) => provider.id === built.entry.id);
  let entry = built.entry;
  // Reconfiguring must not wipe what the wizard has no screen for: a
  // subscription-cli entry can carry a hand-set binPath / extraArgs /
  // streaming flag / spend ceiling, and any entry a request timeout.
  // `upsertLlmProvider` preserves model policy but replaces other fields,
  // so carry them over the same way the stored apiKey is carried below.
  if (existing?.subscriptionCli && entry.subscriptionCli) {
    entry = {
      ...entry,
      subscriptionCli: {
        ...existing.subscriptionCli,
        cli: entry.subscriptionCli.cli,
      },
    };
  }
  if (
    existing?.requestTimeoutMs !== undefined &&
    entry.requestTimeoutMs === undefined
  ) {
    entry = { ...entry, requestTimeoutMs: existing.requestTimeoutMs };
  }
  const preset = wizard.presetId
    ? findProviderPreset(wizard.presetId)
    : undefined;
  // Local servers (including a hand-added loopback endpoint) have no key
  // at all, and keyless-listing services work before one is entered, so
  // an empty key is a valid state for both: nothing is written to .env
  // and requests go out without Authorization.
  const keyOptional = wizardKeyIsOptional(wizard);
  // ATO-1066: a server on another computer on this network never reads
  // the shared compat variables (they usually hold a real cloud key), so
  // a key typed for it lives under a variable of its own.
  const networkKeyEnvVar =
    !preset &&
    entry.kind === "openai-compatible" &&
    isOtherComputerOnNetworkUrl(entry.baseUrl)
      ? (existing?.apiKeyEnvVar ?? networkComputerKeyEnvVar(entry.id))
      : undefined;
  if (wizard.apiKeyBuffer.trim().length > 0) {
    // Validate the value that is actually persisted: the dotenv writer
    // trims, and `trim()` strips U+00A0/U+FEFF paste artifacts that are
    // non-ASCII themselves. Checking the raw buffer here would refuse a
    // key whose stored form is pure ASCII — after the key screen (which
    // trims) already accepted it.
    if (!isAsciiOnly(wizard.apiKeyBuffer.trim())) {
      // A non-ASCII key cannot go into an Authorization header and would
      // otherwise crash the first request with an opaque ByteString error.
      throw new Error(
        "API key contains non-ASCII characters. Use a plain ASCII key.",
      );
    }
    writeProviderApiKeyToDotenv(
      kind,
      wizard.apiKeyBuffer,
      preset?.envVar ?? networkKeyEnvVar,
    );
    if (networkKeyEnvVar) entry = { ...entry, apiKeyEnvVar: networkKeyEnvVar };
  } else if (existing?.apiKey) {
    entry = { ...entry, apiKey: existing.apiKey };
  } else if (networkKeyEnvVar && existing?.apiKeyEnvVar) {
    entry = { ...entry, apiKeyEnvVar: existing.apiKeyEnvVar };
  } else if (
    !keyOptional &&
    !resolveLlmProviderApiKey(entry) &&
    !(existing && resolveLlmProviderApiKey(existing))
  ) {
    throw new Error("API key is empty — paste a key or set it in .env first");
  }

  entry = upsertLlmProvider(entry, {
    activateEmbeddingProviderId: built.activateEmbeddingProviderId,
  });
  setActiveTextProviderInConfig(entry.id);

  return { ...built, entry };
}
