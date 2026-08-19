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
import { isAsciiOnly } from "../../llm/provider/openai/ascii-header-guard.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
import { isLoopbackBaseUrl } from "../persist-user-local-models-config.js";
import { findProviderPreset } from "./provider-presets.js";
import { OPENAI_COMPAT_DEFAULT_BASE_URL } from "./providers-model-options.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

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
 *
 * A hand-added compat endpoint pointing at a loopback address is a local
 * server too, even without a matching preset. A raw `llama-server` on
 * `http://127.0.0.1:9931` needs no key, so an empty one is valid there.
 */
export function wizardKeyIsOptional(wizard: ProvidersWizardState): boolean {
  const preset = wizard.presetId ? findProviderPreset(wizard.presetId) : undefined;
  if (preset && (preset.local || preset.listsModelsWithoutKey)) return true;
  return wizard.kind === "openai-compatible" && isLoopbackBaseUrl(wizard.baseUrlLine);
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
  const typed = wizard.apiKeyBuffer.trim();
  // A non-ASCII key cannot go into an Authorization header. Refusing it
  // here names the problem on the key screen rather than letting the
  // first model-list fetch crash with an opaque ByteString error.
  if (typed && !isAsciiOnly(typed)) {
    return "API key contains non-ASCII characters. Use a plain ASCII key.";
  }
  if (wizardKeyIsOptional(wizard)) return null;
  if (apiKeyForWizard(wizard)) return null;
  return `API key required — paste the key, or set ${envHintForWizard(wizard)} in .env first`;
}
