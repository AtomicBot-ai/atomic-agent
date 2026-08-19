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

import { resolveLlmProviderApiKey } from "../../config/resolve-llm-api-key.js";
import type { UserLlmProviderEntry } from "../../config/llm-config.js";
import { normalizeOpenAiBaseUrl } from "../../llm/provider/openai/normalize-openai-base-url.js";
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
 * Typed key wins; otherwise a key already in the environment needs no
 * retyping.
 */
export function apiKeyForWizard(
  wizard: ProvidersWizardState,
): string | undefined {
  return (
    wizard.apiKeyBuffer.trim() ||
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
 * Why the key screen cannot be left yet, or `null` when it can.
 *
 * The check used to happen only at the end of the wizard, in
 * `saveProviderWizardToConfig`: the operator picked a model, waited for
 * the save, and only then learned the first screen was blank. Refusing
 * here costs one keystroke instead. Whitespace counts as empty — it is
 * what a mis-paste leaves behind, and it would otherwise be written to
 * `.env` as a real key.
 */
export function apiKeyPhaseError(
  wizard: ProvidersWizardState,
): string | null {
  if (wizardKeyIsOptional(wizard)) return null;
  if (apiKeyForWizard(wizard)) return null;
  return `API key required — paste the key, or set ${envHintForWizard(wizard)} in .env first`;
}
