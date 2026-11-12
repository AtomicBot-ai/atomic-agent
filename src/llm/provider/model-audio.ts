import type { ProviderCapabilities } from "./llm-provider.js";
import { getAdvertisedOpenRouterAudio } from "./openrouter/fetch-openrouter-chat-catalog.js";
import type { LlmProviderConfigEntry } from "./registry/provider-types.js";

/**
 * Whether the MODEL a cloud provider link serves takes audio input
 * (ATO-497), resolved per model at construction like vision
 * (`model-vision.ts`). Sources, first that speaks wins:
 *
 * 1. `llm.providers[].userModels[]` row for this model with
 *    `supportsAudio` set.
 * 2. `llm.providers[].supportsAudio` — the operator about the link.
 * 3. OpenRouter's live `/v1/models` row, when the TUI picker fetched it
 *    and the row listed `architecture.input_modalities`.
 * 4. Nothing knows: `false` (`unknown`). Unlike vision, audio is never
 *    assumed: the bundled catalogues record no audio support, and a
 *    model that cannot hear has a working fallback (the file stays on
 *    disk for the `audio-transcribe` skill), so guessing buys nothing.
 */
export interface ModelAudioVerdict {
  audio: boolean;
  audioSource: NonNullable<ProviderCapabilities["audioSource"]>;
}

export function resolveCloudModelAudio(
  entry: LlmProviderConfigEntry,
  modelId: string,
): ModelAudioVerdict {
  const row = entry.userModels?.find((model) => model.id === modelId);
  if (row?.supportsAudio !== undefined) {
    return { audio: row.supportsAudio, audioSource: "config.userModels" };
  }
  if (entry.supportsAudio !== undefined) {
    return { audio: entry.supportsAudio, audioSource: "config.provider" };
  }
  if (entry.kind === "openrouter") {
    const live = getAdvertisedOpenRouterAudio(modelId);
    if (live !== undefined) return { audio: live, audioSource: "catalog.live" };
  }
  return { audio: false, audioSource: "unknown" };
}
