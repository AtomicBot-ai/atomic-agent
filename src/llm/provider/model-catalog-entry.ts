import type { ModelCatalogEntry } from "./model-resolver.js";

/**
 * Row builders shared by the bundled provider catalogs.
 *
 * OpenRouter and aimlapi both ship a static `ReadonlyMap<string,
 * ModelCatalogEntry>` and both used to declare their own private
 * `chatModel` / `embeddingModel` helpers. The two copies had already
 * drifted — one defaulted `supportsTools` to `"parallel"`, the other
 * hard-coded it — so the shared version keeps every field explicit and
 * lets each catalog omit what its API genuinely does not publish
 * (`pricing` is absent from the aimlapi payload, so aimlapi rows carry
 * no price rather than a made-up one).
 */

export type ChatModelSpec = {
  readonly id: string;
  readonly contextWindow: number;
  readonly supportsVision: boolean;
  readonly supportsTools?: "none" | "basic" | "parallel" | "strict";
  readonly supportsPromptCache?: boolean;
  readonly pricing?: { readonly input: number; readonly output: number };
};

export type EmbeddingModelSpec = {
  readonly id: string;
  readonly contextWindow: number;
  readonly dim?: number;
  readonly pricing?: { readonly input: number; readonly output: number };
};

export type CatalogRow = readonly [string, ModelCatalogEntry];

export function chatModel(spec: ChatModelSpec): CatalogRow {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "chat",
      contextWindow: spec.contextWindow,
      supportsVision: spec.supportsVision,
      supportsTools: spec.supportsTools ?? "parallel",
      supportsPromptCache: spec.supportsPromptCache ?? false,
      reasoningFormat: "none",
      ...(spec.pricing ? { pricing: spec.pricing } : {}),
    },
  ];
}

export function embeddingModel(spec: EmbeddingModelSpec): CatalogRow {
  return [
    spec.id,
    {
      id: spec.id,
      kind: "embedding",
      contextWindow: spec.contextWindow,
      ...(spec.dim !== undefined ? { dim: spec.dim } : {}),
      supportsVision: false,
      supportsTools: "none",
      supportsPromptCache: false,
      reasoningFormat: "none",
      ...(spec.pricing ? { pricing: spec.pricing } : {}),
    },
  ];
}
