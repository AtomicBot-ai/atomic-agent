import type { LlmProviderConfigEntry } from "./registry/provider-types.js";
import { AIMLAPI_MODELS_CATALOG } from "./aimlapi/aimlapi-models-catalog.js";
import type { ModelCatalogEntry } from "./model-resolver.js";
import { OPENROUTER_MODELS_CATALOG } from "./openrouter/openrouter-models-catalog.js";

const EMPTY: ReadonlyMap<string, ModelCatalogEntry> = new Map();

/**
 * The bundled model catalog for a provider, or an empty map when the
 * provider ships none.
 *
 * Only the two aggregators carry one. `llama-server` runs local weights
 * that have no list price, and `openai-compatible` / `gemini` point at
 * whatever endpoint the operator configured, so neither has a catalog to
 * look a model up in. An empty map is the honest answer for those: it
 * leaves `resolveModel` on its `userModels` -> defaults path, which is
 * where a hand-configured price would live.
 *
 * These are the static snapshots. `refreshOpenRouterChatCatalogFromApi`
 * and its aimlapi counterpart fetch live rows, including current prices,
 * but only the TUI model picker holds that cache today.
 */
export function catalogForProvider(
  entry: LlmProviderConfigEntry,
): ReadonlyMap<string, ModelCatalogEntry> {
  switch (entry.kind) {
    case "openrouter":
      return OPENROUTER_MODELS_CATALOG;
    case "aimlapi":
      return AIMLAPI_MODELS_CATALOG;
    default:
      return EMPTY;
  }
}
