import type { ResolvedLlmConfig } from "./registry/provider-types.js";
import { catalogForProvider } from "./catalog-for-provider.js";
import { resolveModel } from "./model-resolver.js";

/**
 * Whether the model a provider link serves declares
 * `supportsTools: "strict"` — the one consumer of that level, and the
 * only path from the operator's config to the strict tools payload.
 *
 * It is a per-MODEL fact, not a provider capability: the operator sets
 * it on a `llm.providers[].userModels[]` entry for the one model that
 * needs the provider to constrain the decode (a report of mercury-2.5
 * misforming tool calls without it), while the next model on the same
 * endpoint keeps today's behaviour. No shipped catalog entry declares
 * the level, so a `false` here is the default for every stock config.
 *
 * Called per inference rather than cached, for the same reason the wire
 * slice is: a TUI `setActive` hot-swap must be seen by the next call,
 * not the next process.
 */
export function modelWantsStrictTools(
  resolved: ResolvedLlmConfig,
  providerId: string,
): boolean {
  const entry = resolved.providers.find((p) => p.id === providerId);
  const modelId = entry?.defaultChatModel ?? entry?.model;
  if (!entry || !modelId) return false;
  return (
    resolveModel(entry, modelId, catalogForProvider(entry)).supportsTools ===
    "strict"
  );
}
