import { usesExternalCliAuth, type AtomicAgentConfig } from "../config/index.js";
import {
  isModelDownloaded,
  listLocalModels,
  type LocalModelDef,
} from "../local-llm/index.js";
import { providerKeyStatus } from "../llm/provider/provider-key.js";
import { isLocalProviderUrl } from "../llm/provider/presets/is-local-provider-url.js";

/**
 * What a host can offer when a local model is slow to say anything
 * (ATO-1027): a lighter catalog model, the cloud, or both. Facts only —
 * the host words it and the person decides; nothing here switches.
 */
export interface SlowFirstTokenHint {
  /** The managed model the turn is waiting on; `null` on an external server. */
  modelId: string | null;
  /**
   * The largest curated model at most `LIGHTER_SIZE_RATIO` the size of
   * the current one, with whether its weights are already on disk.
   * `null` when the current model is unknown or nothing that small exists.
   */
  lighterModel: { id: string; name: string; fileSizeGb: number; downloaded: boolean } | null;
  /** A cloud provider with a key (or a sign-in) is configured. */
  cloudAvailable: boolean;
}

/** A lighter model must be at most this share of the current one's size. */
export const LIGHTER_SIZE_RATIO = 0.6;

export type HintConfig = Pick<AtomicAgentConfig, "llm" | "localModels" | "paths">;

/**
 * The hint for the active route, or `null` when the turn is not on a local
 * model (a cloud provider, a Fusion orchestrator): the wait is not the
 * machine's, and no lighter model would help.
 */
export function buildSlowFirstTokenHint(
  cfg: HintConfig,
  deps: {
    models?: readonly LocalModelDef[];
    isDownloaded?: (model: LocalModelDef) => boolean;
  } = {},
): SlowFirstTokenHint | null {
  if (!runsOnLocalModel(cfg)) return null;
  const models = deps.models ?? listLocalModels();
  const isDownloaded =
    deps.isDownloaded ??
    ((model: LocalModelDef) => isModelDownloaded(cfg.paths.localModelsDataDir, model));
  const modelId = cfg.localModels.mode === "managed" ? cfg.localModels.managed.modelId : null;
  const current = modelId === null ? undefined : models.find((m) => m.id === modelId);
  const lighter = current === undefined ? undefined : pickLighter(current, models);
  return {
    modelId,
    lighterModel:
      lighter === undefined
        ? null
        : {
            id: lighter.id,
            name: lighter.name,
            fileSizeGb: lighter.fileSizeGb,
            downloaded: safely(() => isDownloaded(lighter), false),
          },
    cloudAvailable: hasCloudProvider(cfg),
  };
}

/** The active text provider is a llama-server link (no `llm` block means the local one). */
export function runsOnLocalModel(cfg: Pick<AtomicAgentConfig, "llm">): boolean {
  const llm = cfg.llm;
  if (llm === undefined) return true;
  const entry = llm.providers.find((p) => p.id === llm.activeTextProvider);
  if (entry === undefined) return llm.activeTextProvider === "local-llama";
  return entry.kind === "llama-server";
}

function pickLighter(
  current: LocalModelDef,
  models: readonly LocalModelDef[],
): LocalModelDef | undefined {
  const ceiling = current.fileSizeGb * LIGHTER_SIZE_RATIO;
  return models
    .filter(
      (m) =>
        m.id !== current.id &&
        m.family !== "custom" &&
        m.uncensored !== true &&
        m.fileSizeGb <= ceiling,
    )
    .sort((a, b) => b.fileSizeGb - a.fileSizeGb)[0];
}

function hasCloudProvider(cfg: Pick<AtomicAgentConfig, "llm">): boolean {
  const providers = cfg.llm?.providers ?? [];
  return providers.some((entry) => {
    if (entry.kind === "llama-server") return false;
    if (isLocalProviderUrl(entry.baseUrl ?? entry.url)) return false;
    try {
      // A key, or a vendor CLI's own sign-in. A keyless entry on a local
      // preset (Ollama, LM Studio) is the same machine, not the cloud.
      const { state } = providerKeyStatus(entry);
      return state === "present" || (state === "not-needed" && usesExternalCliAuth(entry));
    } catch {
      return false;
    }
  });
}

function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
