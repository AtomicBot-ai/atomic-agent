/**
 * What the wizard's current state says about the *service* being
 * configured: which endpoint it points at, which key it would use, and
 * whether that key is allowed to be missing.
 *
 * Split out of `providers-wizard-key-bindings.ts`, which sits on the
 * 300-line limit: the key screen needs these answers before it can
 * refuse an empty key, and so does every other surface that renders the
 * wizard.
 */

import { getConfig } from "../../config/index.js";
import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { DEFAULT_AIMLAPI_BASE } from "../../llm/provider/aimlapi/aimlapi-provider.js";
import {
  DEFAULT_GEMINI_BASE,
  GEMINI_API_PATH_PREFIX,
} from "../../llm/provider/gemini/gemini-provider.js";
import { getCachedOpenAiCompatModelsForBaseUrl } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
import {
  DEFAULT_OPENROUTER_BASE,
  OPENROUTER_APP_CATEGORIES,
  OPENROUTER_APP_REFERER,
  OPENROUTER_APP_TITLE,
} from "../../llm/provider/openrouter/openrouter-provider.js";
import { pickProbeModels } from "../../llm/provider/verify/index.js";
import type { ProviderVerifyTarget } from "../../llm/provider/verify/index.js";
import { isLocalProviderUrl } from "./is-local-provider-url.js";
import { findProviderPreset } from "./provider-presets.js";
import {
  AIMLAPI_DEFAULT_CHAT_MODEL,
  GEMINI_DEFAULT_CHAT_MODEL,
  OPENAI_COMPAT_DEFAULT_BASE_URL,
  OPENAI_COMPAT_DEFAULT_CHAT_MODEL,
  OPENROUTER_DEFAULT_CHAT_MODEL,
} from "./providers-model-options.js";
import type {
  ProvidersWizardKind,
  ProvidersWizardState,
} from "./providers-wizard-state.js";

/** Normalized so the fetch, the cache key and the displayed URL always agree. */
export function baseUrlForWizard(wizard: ProvidersWizardState): string {
  return (
    normalizeOpenAiBaseUrl(wizard.baseUrlLine) || OPENAI_COMPAT_DEFAULT_BASE_URL
  );
}

/**
 * The config entry this wizard run would produce, reduced to what key
 * resolution needs. Built from the selected kind — not a fixed
 * `openai-compatible` shape — so `resolveLlmProviderApiKey` reads the
 * variable this service actually uses. Probing with the compat entry
 * made an unrelated `OPENAI_API_KEY` answer for OpenRouter, AI/ML API
 * and Gemini alike: the wrong service's key, presented as this one's.
 */
function keyLookupEntryForWizard(
  wizard: ProvidersWizardState,
): UserLlmProviderEntry {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  const kind = wizard.kind ?? "openai-compatible";
  return {
    id: wizard.providerId ?? preset?.id ?? kind,
    kind,
    ...(preset ? { apiKeyEnvVar: preset.envVar } : {}),
  };
}

/**
 * The `config.json` entry a `configure` run would overwrite, or
 * `undefined` while adding. `saveProviderWizardToConfig` keeps this
 * entry's `apiKey` when the key screen is left blank, so every question
 * about "does this wizard have a key" has to see it: a key the operator
 * typed once lives in `config.json` with nothing in `.env` to find.
 */
function storedEntryForWizard(
  wizard: ProvidersWizardState,
): UserLlmProviderEntry | undefined {
  const { mode, providerId } = wizard;
  if (mode !== "configure" || !providerId) return undefined;
  return getConfig().llm?.providers.find(
    (provider) => provider.id === providerId,
  );
}

/**
 * Typed key wins; then the key the entry being reconfigured already has
 * (stored, or under its own env var); then a key already in the
 * environment for this kind. Same union `saveProviderWizardToConfig`
 * accepts, so the key screen never refuses what the save would take.
 */
export function apiKeyForWizard(
  wizard: ProvidersWizardState,
): string | undefined {
  const typed = wizard.apiKeyBuffer.trim();
  if (typed) return typed;
  const stored = storedEntryForWizard(wizard);
  return (
    (stored && resolveLlmProviderApiKey(stored)) ??
    resolveLlmProviderApiKey(keyLookupEntryForWizard(wizard))
  );
}

/**
 * Env var named on the key screen. A preset names its own variable;
 * naming the shared compat one there would promise Groq's key a home it
 * does not use.
 */
export function envHintForWizard(wizard: ProvidersWizardState): string {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  if (preset) return preset.envVar;
  if (wizard.kind === "openrouter") return "OPENROUTER_API_KEY";
  if (wizard.kind === "aimlapi") return "AIMLAPI_API_KEY";
  if (wizard.kind === "gemini") return "GEMINI_API_KEY";
  return "OPENAI_COMPAT_API_KEY";
}

/**
 * `true` when saving without any key is a legitimate outcome: servers on
 * the operator's own machine have no key at all, and keyless-listing
 * services work before one is entered. Both save with an empty key and
 * send requests without an Authorization header.
 */
export function wizardKeyIsOptional(wizard: ProvidersWizardState): boolean {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  return Boolean(preset && (preset.local || preset.listsModelsWithoutKey));
}

/**
 * What leaving the key screen blank means for this run, in the operator's
 * words. Local servers and keyless-listing services save without a key;
 * a reconfigure keeps the one already in `config.json` — telling that
 * operator the key must be "in .env" describes a file it was never
 * written to. Everyone else does need one there.
 */
export function emptyKeyMeaningForWizard(wizard: ProvidersWizardState): string {
  if (wizardKeyIsOptional(wizard)) {
    return "Optional for this service — leave empty to connect without a key.";
  }
  if (storedEntryForWizard(wizard)?.apiKey) {
    return "Leave empty to keep the key already saved.";
  }
  return "Leave empty only if the key is already in .env.";
}

/**
 * Why the key screen cannot be left yet, or `null` when it can.
 *
 * The check used to happen only at the end of the wizard, in
 * `saveProviderWizardToConfig`: the operator picked a model, waited for
 * the save, and only then learned the first screen was blank. Refusing
 * here costs one keystroke instead. Whitespace counts as empty — it is
 * what a mis-paste leaves behind, and it would otherwise be written to
 * `.env` as a real key.
 *
 * Never stricter than the save it fronts: `apiKeyForWizard` consults the
 * stored entry the same way, so reconfiguring a provider whose key is
 * already saved passes with a blank screen instead of demanding it again.
 */
export function apiKeyPhaseError(
  wizard: ProvidersWizardState,
): string | null {
  if (wizardKeyIsOptional(wizard)) return null;
  if (apiKeyForWizard(wizard)) return null;
  return `API key required — paste the key, or set ${envHintForWizard(wizard)} in .env first`;
}

/**
 * How each built-in kind is named in prose. The raw kind is a config
 * token, not a service name: `"openrouter" rejected this key` in the
 * middle of a screen whose own row says "OpenRouter" reads as a
 * different, lower-case product.
 */
const KIND_SERVICE_LABELS: Record<ProvidersWizardKind, string> = {
  openrouter: "OpenRouter",
  aimlapi: "AI/ML API",
  gemini: "Gemini",
  "openai-compatible": "this endpoint",
};

/** Service name for headings and for every sentence about a failure. */
export function providerLabelForWizard(wizard: ProvidersWizardState): string {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  if (preset) return preset.label;
  return wizard.kind ? KIND_SERVICE_LABELS[wizard.kind] : "provider";
}

/** The model this wizard run is about to save, before any defaulting. */
function chosenModelForWizard(wizard: ProvidersWizardState): string {
  const typed = wizard.chatModelLine.trim();
  if (wizard.selectedChatModelId) return wizard.selectedChatModelId;
  if (typed.length > 0) return typed;
  if (wizard.kind === "openrouter") return OPENROUTER_DEFAULT_CHAT_MODEL;
  if (wizard.kind === "aimlapi") return AIMLAPI_DEFAULT_CHAT_MODEL;
  if (wizard.kind === "gemini") return GEMINI_DEFAULT_CHAT_MODEL;
  return OPENAI_COMPAT_DEFAULT_CHAT_MODEL;
}

function endpointForKind(
  kind: ProvidersWizardKind,
  wizard: ProvidersWizardState,
): { baseUrl: string; apiPathPrefix: string; extraHeaders?: Record<string, string> } {
  if (kind === "openrouter") {
    return {
      baseUrl: DEFAULT_OPENROUTER_BASE,
      apiPathPrefix: "/v1",
      // The same attribution the real provider sends, so the check is
      // billed and rate-limited as this app rather than as a stranger.
      extraHeaders: {
        "HTTP-Referer": OPENROUTER_APP_REFERER,
        "X-Title": OPENROUTER_APP_TITLE,
        "X-OpenRouter-Categories": OPENROUTER_APP_CATEGORIES,
      },
    };
  }
  if (kind === "aimlapi") {
    return { baseUrl: DEFAULT_AIMLAPI_BASE, apiPathPrefix: "/v1" };
  }
  if (kind === "gemini") {
    return {
      baseUrl: DEFAULT_GEMINI_BASE,
      apiPathPrefix: GEMINI_API_PATH_PREFIX,
    };
  }
  return { baseUrl: baseUrlForWizard(wizard), apiPathPrefix: "/v1" };
}

/**
 * What to send the credential check, or `null` when there is nothing
 * worth checking: a service that legitimately has no key, a screen with
 * no key resolved (the key-screen gate already refused that), or a
 * server on this machine, which has no account to be wrong about.
 */
export function verifyTargetForWizard(
  wizard: ProvidersWizardState,
): ProviderVerifyTarget | null {
  const kind = wizard.kind;
  if (!kind) return null;
  if (wizardKeyIsOptional(wizard)) return null;
  const apiKey = apiKeyForWizard(wizard)?.trim();
  if (!apiKey) return null;

  const endpoint = endpointForKind(kind, wizard);
  if (isLocalProviderUrl(endpoint.baseUrl)) return null;

  const listed =
    kind === "openai-compatible"
      ? getCachedOpenAiCompatModelsForBaseUrl(endpoint.baseUrl)
      : undefined;
  const probeModels = pickProbeModels({
    kind,
    selectedModelId: chosenModelForWizard(wizard),
    ...(listed ? { listedModelIds: listed } : {}),
  });

  return {
    label: providerLabelForWizard(wizard),
    baseUrl: endpoint.baseUrl,
    apiPathPrefix: endpoint.apiPathPrefix,
    apiKey,
    probeModels,
    ...(endpoint.extraHeaders ? { extraHeaders: endpoint.extraHeaders } : {}),
  };
}
