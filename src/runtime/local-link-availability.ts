import type { AtomicAgentConfig } from "../config/index.js";
import {
  getLocalModelDef,
  isKnownLocalModelId,
  isModelDownloaded,
} from "../local-llm/index.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

/**
 * Is `providerId` the managed local link with no model on disk to serve?
 *
 * True only when every part of that is known: the entry is a
 * `llama-server` link pointed at the managed daemon (no URL of its own,
 * or the managed one), the backend is in managed mode, and the selected
 * model is either unset, unknown, or not downloaded — the same reading
 * `readLocalTurnGateFacts` gives the TUI. The daemon cannot start
 * without weights, so falling over to this link only trades the
 * previous link's error for a refused connection the turn then waits on.
 *
 * An external server (`mode: "external"`, or an entry with its own URL)
 * is never judged from here: whether it serves is the server's business,
 * and the turn's own completion is the verdict on it.
 */
export function isLocalLinkWithoutModel(
  llm: ResolvedLlmConfig,
  providerId: string,
  cfg: Pick<AtomicAgentConfig, "localModels" | "paths">,
  modelOnDisk: (
    dataDir: string,
    modelId: string,
  ) => boolean = defaultModelOnDisk,
): boolean {
  const entry = llm.providers.find((p) => p.id === providerId);
  if (entry === undefined || entry.kind !== "llama-server") return false;
  if (cfg.localModels.mode !== "managed") return false;
  if (entry.url !== undefined && entry.url !== cfg.localModels.url) {
    return false;
  }
  const modelId = cfg.localModels.managed.modelId;
  if (modelId === null) return true;
  return !modelOnDisk(cfg.paths.localModelsDataDir, modelId);
}

function defaultModelOnDisk(dataDir: string, modelId: string): boolean {
  return (
    isKnownLocalModelId(modelId) &&
    isModelDownloaded(dataDir, getLocalModelDef(modelId))
  );
}
