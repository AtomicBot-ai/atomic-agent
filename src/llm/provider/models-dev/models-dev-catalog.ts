import type { ModelCatalogEntry } from "../model-resolver.js";
import type { LlmProviderConfigEntry } from "../registry/provider-types.js";
import { modelsDevModelIdCandidates, modelsDevProviderFor } from "./models-dev-ids.js";
import { MODELS_DEV_SNAPSHOT, type ModelsDevRow } from "./models-dev-snapshot.js";

type Snapshot = Readonly<Record<string, Readonly<Record<string, ModelsDevRow>>>>;

/**
 * A models.dev row for a model on a configured provider, as a catalog
 * entry: context window, output ceiling and per-1M-token prices
 * (ATO-647). `undefined` when the provider is not one the snapshot
 * carries or the model is not in it.
 *
 * Only limits and prices come from models.dev. Every capability field
 * is the resolver's own default (`supportsVision: false`, `"parallel"`
 * tools, no prompt cache flag, no reasoning format): the entry feeds
 * pricing and window sizing, not vision or tool routing, which keep
 * their own hand-verified sources.
 *
 * The row is keyed by the id the caller asked for, so a hit through
 * the `models/` prefix or a case-insensitive match still reports the
 * service's id.
 */
export function modelsDevCatalogEntry(
  entry: Pick<LlmProviderConfigEntry, "id" | "kind" | "baseUrl" | "url">,
  modelId: string,
  snapshot: Snapshot = MODELS_DEV_SNAPSHOT,
): ModelCatalogEntry | undefined {
  const providerId = modelsDevProviderFor(entry);
  if (providerId === undefined) return undefined;
  const models = snapshot[providerId];
  if (models === undefined) return undefined;
  const row = findRow(models, modelId);
  if (row === undefined) return undefined;
  return {
    id: modelId,
    kind: "chat",
    contextWindow: row.context,
    ...(row.output === undefined ? {} : { maxOutputTokens: row.output }),
    supportsVision: false,
    supportsTools: "parallel",
    supportsPromptCache: false,
    reasoningFormat: "none",
    ...(row.cost === undefined ? {} : { pricing: { ...row.cost } }),
  };
}

function findRow(
  models: Readonly<Record<string, ModelsDevRow>>,
  modelId: string,
): ModelsDevRow | undefined {
  const candidates = modelsDevModelIdCandidates(modelId);
  for (const id of candidates) {
    if (Object.hasOwn(models, id)) return models[id];
  }
  const wanted = new Set(candidates.map((id) => id.toLowerCase()));
  const match = Object.keys(models).find((id) => wanted.has(id.toLowerCase()));
  return match === undefined ? undefined : models[match];
}
