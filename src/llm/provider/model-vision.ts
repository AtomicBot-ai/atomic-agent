import { getAdvertisedAimlapiVision } from "./aimlapi/fetch-aimlapi-chat-catalog.js";
import { AIMLAPI_CHAT_MODEL_ORDER } from "./aimlapi/aimlapi-models-catalog.js";
import { catalogForProvider } from "./catalog-for-provider.js";
import type { ProviderCapabilities } from "./llm-provider.js";
import { getAdvertisedOpenRouterVision } from "./openrouter/fetch-openrouter-chat-catalog.js";
import { OPENROUTER_CHAT_MODEL_ORDER } from "./openrouter/openrouter-models-catalog.js";
import { modelCannotSee } from "./model-vision-rejections.js";
import type { LlmProviderConfigEntry } from "./registry/provider-types.js";

/**
 * Whether the MODEL a cloud provider link serves can read images.
 *
 * Vision used to be a provider fact: every OpenAI-compatible factory
 * passed `entry.supportsVision ?? true`, and no stock entry sets that
 * flag, so a text-only model (aimlapi's `deepseek/deepseek-v4-flash`)
 * was offered `vision.describe`, took four calls at it, got four
 * `400 Validation failed` back and then reached for `magick` in the
 * shell. A provider link serves exactly one chat model — the factory
 * rebuilds it on every model switch — so the answer is resolved here,
 * per model, at construction.
 *
 * Sources, first that speaks wins:
 *
 * 1. `llm.providers[].userModels[]` row for this model with
 *    `supportsVision` set — the operator about this one model.
 * 2. `llm.providers[].supportsVision` — the operator about the whole
 *    link (a self-hosted endpoint that serves one known model).
 * 3. The bundled catalogue (`catalogForProvider`: aimlapi, openrouter),
 *    hand-verified per id.
 * 4. The live `/v1/models` cache, when the TUI picker has fetched it and
 *    the row stated image support (OpenRouter's
 *    `architecture.input_modalities`, aimlapi's `features`). Silence is
 *    not an answer here.
 * 5. Nothing knows: `assumed`. The tool is offered, because refusing a
 *    model nobody has described would take vision away from every
 *    custom endpoint that can see. The first image rejection from the
 *    service marks the model text-only for the rest of the process
 *    (`markModelCannotSee`) and later calls are refused up front.
 */
export interface ModelVisionVerdict {
  vision: boolean;
  visionSource: ProviderCapabilities["visionSource"];
}

export function resolveCloudModelVision(
  entry: LlmProviderConfigEntry,
  modelId: string,
): ModelVisionVerdict {
  const row = entry.userModels?.find((model) => model.id === modelId);
  if (row?.supportsVision !== undefined) {
    return { vision: row.supportsVision, visionSource: "config.userModels" };
  }
  if (entry.supportsVision !== undefined) {
    return { vision: entry.supportsVision, visionSource: "config.provider" };
  }
  if (modelCannotSee(entry.id, modelId)) {
    return { vision: false, visionSource: "rejected-images" };
  }
  const catalogued = catalogForProvider(entry).get(modelId);
  if (catalogued !== undefined && catalogued.kind === "chat") {
    return { vision: catalogued.supportsVision, visionSource: "catalog" };
  }
  const live = advertisedLiveVision(entry.kind, modelId);
  if (live !== undefined) {
    return { vision: live, visionSource: "catalog.live" };
  }
  return { vision: true, visionSource: "assumed" };
}

function advertisedLiveVision(
  kind: string,
  modelId: string,
): boolean | undefined {
  switch (kind) {
    case "openrouter":
      return getAdvertisedOpenRouterVision(modelId);
    case "aimlapi":
      return getAdvertisedAimlapiVision(modelId);
    default:
      return undefined;
  }
}

/**
 * Up to three vision-capable models from the provider's curated order,
 * for the refusal to name somewhere to go. Empty for a kind without a
 * catalogue — the refusal then points at local models and config.
 */
export function visionCapableAlternatives(
  entry: Pick<LlmProviderConfigEntry, "kind" | "id">,
  limit = 3,
): string[] {
  const order =
    entry.kind === "aimlapi"
      ? AIMLAPI_CHAT_MODEL_ORDER
      : entry.kind === "openrouter"
        ? OPENROUTER_CHAT_MODEL_ORDER
        : [];
  const catalog = catalogForProvider(entry as LlmProviderConfigEntry);
  const out: string[] = [];
  for (const id of order) {
    if (id === "openrouter/auto") continue;
    const row = catalog.get(id);
    if (row?.kind === "chat" && row.supportsVision) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}
