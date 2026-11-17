import type { LlmProviderConfigEntry } from "../registry/provider-types.js";
import {
  PROVIDER_PRESETS,
  presetForEntryId,
} from "../presets/provider-presets.js";

/**
 * Where our provider ids and models.dev's differ (ATO-647).
 *
 * models.dev keys each service by its own slug and, inside it, each
 * model by the id that service's API takes, so the main mapping is the
 * provider: our preset id (left) to the models.dev slug (right). Presets
 * with the same name on both sides are listed too, so this table is the
 * whole list of what the snapshot carries.
 *
 * Left out on purpose:
 * - local servers (`atomic-chat`, `lmstudio`, `ollama`): no list price;
 * - `ollama-cloud`: billed by subscription plan, and a per-token price
 *   would show spend nobody is charged;
 * - `hyperbolic`, `nous`: models.dev has no entry for them.
 */
export const MODELS_DEV_PROVIDER_FOR_PRESET: Readonly<Record<string, string>> = {
  anthropic: "anthropic",
  cerebras: "cerebras",
  dashscope: "alibaba",
  deepseek: "deepseek",
  fireworks: "fireworks-ai",
  groq: "groq",
  mistral: "mistral",
  moonshot: "moonshotai",
  novita: "novita-ai",
  perplexity: "perplexity",
  sambanova: "sambanova",
  sarvam: "sarvam",
  together: "togetherai",
  xai: "xai",
};

/** Provider kinds that are one service each, not a preset of `openai-compatible`. */
export const MODELS_DEV_PROVIDER_FOR_KIND: Readonly<Record<string, string>> = {
  gemini: "google",
};

/** Every models.dev slug the snapshot keeps; the generator reads it. */
export const MODELS_DEV_PROVIDER_IDS: readonly string[] = [
  ...new Set([
    ...Object.values(MODELS_DEV_PROVIDER_FOR_PRESET),
    ...Object.values(MODELS_DEV_PROVIDER_FOR_KIND),
  ]),
].sort();

/**
 * The models.dev slug for a configured provider entry, or `undefined`
 * when the snapshot has nothing to say about it.
 *
 * A preset entry is found by its id (`groq`, `groq-2`) and must still
 * point at the preset's host: an entry renamed `groq` that talks to a
 * proxy is not priced as Groq. An entry under another id is matched by
 * its host alone, so a hand-written `openai-compatible` block for
 * `api.moonshot.ai` is priced as Moonshot.
 */
export function modelsDevProviderFor(
  entry: Pick<LlmProviderConfigEntry, "id" | "kind" | "baseUrl" | "url">,
): string | undefined {
  const byKind = MODELS_DEV_PROVIDER_FOR_KIND[entry.kind];
  if (byKind !== undefined) return byKind;
  if (entry.kind !== "openai-compatible") return undefined;
  const host = hostOf(entry.baseUrl ?? entry.url);
  const named = presetForEntryId(entry.id);
  if (named !== undefined && (host === undefined || host === hostOf(named.baseUrl))) {
    return MODELS_DEV_PROVIDER_FOR_PRESET[named.id];
  }
  if (host === undefined) return undefined;
  const byHost = PROVIDER_PRESETS.find((preset) => hostOf(preset.baseUrl) === host);
  return byHost === undefined ? undefined : MODELS_DEV_PROVIDER_FOR_PRESET[byHost.id];
}

/**
 * Ids to try, in order, for a model id as the service reported it: as
 * is, then without Gemini's `models/` prefix (its native API names
 * models so). The lookup also falls back to a case-insensitive match,
 * for services whose listing and models.dev disagree on case.
 */
export function modelsDevModelIdCandidates(modelId: string): string[] {
  const bare = modelId.startsWith("models/") ? modelId.slice("models/".length) : modelId;
  return bare === modelId ? [modelId] : [modelId, bare];
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || url.trim() === "") return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}
