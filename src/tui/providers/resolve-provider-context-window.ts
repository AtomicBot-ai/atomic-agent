import { catalogForProvider } from "../../llm/provider/catalog-for-provider.js";
import { resolveModel } from "../../llm/provider/model-resolver.js";
import type { LlmProviderConfigEntry } from "../../llm/provider/registry/provider-types.js";

/**
 * The context window a cloud provider's chat model is known to have, or
 * `null` when nobody has actually said.
 *
 * The runtime only learns a window from the llama-server `/props` probe,
 * so a cloud turn builds its prompt with `contextWindow: null` and the
 * composer has no denominator to draw a gauge against. The bundled
 * catalogues do know, for the two aggregators, and an operator can state
 * it by hand in `userModels`.
 *
 * `resolveModel` answers with `source: "default"` when it knows nothing
 * and is falling back to a nominal 128k — which is a guess, and a guess
 * rendered as `62%` is worse than no gauge at all. Those come back
 * `null` on purpose.
 */
export function resolveProviderContextWindow(
  entry: LlmProviderConfigEntry,
  modelId: string | null,
): number | null {
  if (!modelId) return null;
  if (entry.kind === "llama-server") return null;
  const resolved = resolveModel(entry, modelId, catalogForProvider(entry));
  if (resolved.source === "default") return null;
  return resolved.contextWindow > 0 ? resolved.contextWindow : null;
}
