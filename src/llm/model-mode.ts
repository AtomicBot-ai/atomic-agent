import type { ModelMode } from "../config/model-mode.js";
import type { ResolvedLlmConfig } from "./provider/registry/provider-types.js";

export interface ResolvedModelMode {
  readonly mode: ModelMode;
  readonly source: "model" | "provider" | "legacy";
  readonly providerId: string;
  readonly modelId: string | null;
}

/** Credential-free snapshot owned by one turn and inherited by its workers. */
export interface ModelModePolicy {
  readonly activeProviderId: string;
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly modelId: string | null;
    readonly mode?: ModelMode;
    readonly models: Readonly<Record<string, ModelMode>>;
  }>;
}

export function captureModelModePolicy(
  config: ResolvedLlmConfig,
  modelName?: (providerId: string) => string | null,
): ModelModePolicy {
  return Object.freeze({
    activeProviderId: config.activeTextProvider,
    providers: Object.freeze(config.providers.map((entry) => Object.freeze({
      id: entry.id,
      modelId: modelName?.(entry.id) ?? entry.defaultChatModel ?? entry.model ?? null,
      ...(entry.modelMode ? { mode: entry.modelMode } : {}),
      models: Object.freeze({ ...entry.modelModes }),
    }))),
  });
}

export function resolveModelMode(
  policy: ModelModePolicy,
  providerId = policy.activeProviderId,
  modelId?: string | null,
): ResolvedModelMode {
  const entry = policy.providers.find((provider) => provider.id === providerId);
  const id = modelId === undefined ? entry?.modelId ?? null : modelId;
  const override = id !== null && entry && Object.hasOwn(entry.models, id)
    ? entry.models[id]
    : undefined;
  return {
    mode: override ?? entry?.mode ?? "local",
    source: override ? "model" : entry?.mode ? "provider" : "legacy",
    providerId,
    modelId: id,
  };
}
