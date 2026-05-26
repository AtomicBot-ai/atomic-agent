import type {
  LlmProviderConfigEntry,
  UserModelConfigEntry,
} from "./registry/provider-types.js";

export type ResolvedModel = {
  id: string;
  kind: "chat" | "embedding";
  contextWindow: number;
  dim?: number;
  supportsVision: boolean;
  supportsTools: "none" | "basic" | "parallel" | "strict";
  supportsPromptCache: boolean;
  reasoningFormat: UserModelConfigEntry["reasoningFormat"];
  pricing?: UserModelConfigEntry["pricing"];
  source: "user" | "catalog" | "live" | "default";
};

export type ModelCatalogEntry = Omit<ResolvedModel, "source"> & {
  source?: never;
};

const DEFAULT_CHAT: ResolvedModel = {
  id: "unknown",
  kind: "chat",
  contextWindow: 128_000,
  supportsVision: false,
  supportsTools: "parallel",
  supportsPromptCache: false,
  reasoningFormat: "none",
  source: "default",
};

/**
 * Merge order: userModels > catalog > defaults. Live fetch is layered in
 * Phase 5; callers pass `liveIds` when a refresh cache is available.
 */
export function resolveModel(
  providerEntry: LlmProviderConfigEntry,
  modelId: string,
  catalog: ReadonlyMap<string, ModelCatalogEntry> = new Map(),
  liveIds?: ReadonlySet<string>,
): ResolvedModel {
  const user = providerEntry.userModels?.find((m) => m.id === modelId);
  if (user) {
    return mergeResolved(modelId, user, "user");
  }
  const fromCatalog = catalog.get(modelId);
  if (fromCatalog) {
    return { ...fromCatalog, source: "catalog" };
  }
  if (liveIds?.has(modelId)) {
    return {
      ...DEFAULT_CHAT,
      id: modelId,
      source: "live",
    };
  }
  return {
    ...DEFAULT_CHAT,
    id: modelId,
  };
}

function mergeResolved(
  id: string,
  user: UserModelConfigEntry,
  source: ResolvedModel["source"],
): ResolvedModel {
  return {
    id,
    kind: user.kind,
    contextWindow: user.contextWindow ?? DEFAULT_CHAT.contextWindow,
    ...(user.dim !== undefined ? { dim: user.dim } : {}),
    supportsVision: user.supportsVision ?? false,
    supportsTools: user.supportsTools ?? "parallel",
    supportsPromptCache: user.supportsPromptCache ?? false,
    reasoningFormat: user.reasoningFormat ?? "none",
    ...(user.pricing ? { pricing: user.pricing } : {}),
    source,
  };
}
