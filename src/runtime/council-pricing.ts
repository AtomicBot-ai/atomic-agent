import type { AtomicAgentConfig } from "../config/index.js";
import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";
import { resolveLlmConfig } from "../llm/provider/registry/provider-types.js";
import { parseModelSpecs, type CouncilPrice } from "../llm/toolcall-bench/index.js";
import { resolveModelPricingFor } from "./resolve-model-pricing.js";

/**
 * How each council seat is billed (ATO-2432), for the forecast said
 * before the council runs. The same rule as the spend readout
 * (`hasPricedCloudLink`): the built-in local link, a server on a local
 * address and plan-billed subscriptions cost nothing per token; any other
 * link is priced from `userModels`, the bundled catalogs or models.dev,
 * and is "unknown" when none of them knows the model.
 */
export function councilPriceLookup(config: AtomicAgentConfig): (spec: string) => CouncilPrice {
  const resolved = resolveLlmConfig(config);
  return (raw) => {
    const spec = parseModelSpecs(raw, resolved.activeTextProvider)[0];
    const entry = spec ? resolved.providers.find((p) => p.id === spec.providerId) : undefined;
    if (!spec || !entry) return { kind: "unknown" };
    if (entry.kind === "llama-server" || entry.kind === "subscription-cli" || entry.kind === "subscription-oauth") {
      return { kind: "free" };
    }
    if (isLocalServerUrl(entry.baseUrl ?? entry.url)) return { kind: "free" };
    const modelId = spec.model ?? entry.defaultChatModel ?? entry.model ?? null;
    const pricing = resolveModelPricingFor(resolved, modelId, entry.id)?.pricing;
    return pricing ? { kind: "priced", pricing: { input: pricing.input, output: pricing.output } } : { kind: "unknown" };
  };
}
