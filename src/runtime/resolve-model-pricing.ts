import { catalogForProvider } from "../llm/provider/catalog-for-provider.js";
import {
  resolveModel,
  type ResolvedModel,
} from "../llm/provider/model-resolver.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/index.js";

/**
 * Pricing for a model id on one provider, when any is known.
 *
 * Two sources, in `resolveModel`'s own precedence: a hand-configured
 * `userModels[].pricing` first, then the provider's bundled catalog.
 * The catalog is what makes cost work out of the box on OpenRouter and
 * aimlapi, whose published prices ship with the agent; without it only
 * operators who priced their models by hand ever saw a `cost_usd`.
 *
 * `providerId` is the link that SERVED the completion — the fallback
 * chain's pick, or a fusion worker's pin — and defaults to the active
 * text provider. Pricing the served tokens against the active provider
 * would misprice every fallover and every worker turn: in fusion mode
 * the active provider is the cloud orchestrator while most tokens are
 * spent on the local leg, which resolves to no pricing at all (turn
 * cost is reported as absent rather than zero for local runners).
 */
export function resolveModelPricingFor(
  resolved: ResolvedLlmConfig,
  modelId: string | null,
  providerId?: string,
): ResolvedModel | undefined {
  if (!modelId) return undefined;
  const id = providerId ?? resolved.activeTextProvider;
  const entry = resolved.providers.find((p) => p.id === id);
  if (!entry) return undefined;
  return resolveModel(entry, modelId, catalogForProvider(entry));
}
