import type { getConfig } from "../config/index.js";
import {
  EMBEDDING_MODELS_CATALOG,
  loraAdapterForModel,
  loraAdapterKey,
  readRunningPid,
  reclaimManagedPort,
  type ReclaimOutcome,
  type ReclaimRequest,
} from "../local-llm/index.js";

type Config = ReturnType<typeof getConfig>;
type Reclaim = (req: ReclaimRequest) => Promise<ReclaimOutcome>;

/**
 * Clear a managed port before `models start` launches on it (ATO-2458),
 * the same rules as the TUI's start (`reclaimManagedPort`) but never the
 * move: our own server already serving the model is adopted, our own
 * wedged one or another state dir's abandoned one is stopped, and
 * anything else keeps the port, so the launch reports its
 * `PortTakenError` as before. The port is never written to config here:
 * the desktop's agent process caches its config (ATO-1750) and would keep
 * talking to the old address.
 *
 * Only when nothing of ours is recorded on the role: a daemon with a live
 * pid file is the start's own "already running" refusal, unchanged.
 *
 * Returns the adopted pid, or `null` when the launch should go ahead.
 */
export async function clearChatPortForStart(
  cfg: Config,
  modelId: string,
  reclaim: Reclaim = reclaimManagedPort,
): Promise<number | null> {
  const dataDir = cfg.paths.localModelsDataDir;
  if (readRunningPid(dataDir, "chat") !== null) return null;
  const outcome = await safely(reclaim, {
    port: cfg.localModels.managed.port,
    role: "chat",
    ownDataDir: dataDir,
    alias: modelId,
    avoidPorts: [cfg.localModels.embeddings.port],
    // A server launched with another LoRA adapter is restarted, not adopted.
    loraAdapter: loraAdapterKey(loraAdapterForModel(cfg.localModels.managed.loraAdapters, modelId)),
    move: false,
  });
  return settle(outcome, "chat");
}

/** The same for the embedding daemon's port; Core's own embedding module picks its port itself. */
export async function clearEmbeddingPortForStart(
  cfg: Config,
  modelId: string,
  reclaim: Reclaim = reclaimManagedPort,
): Promise<number | null> {
  if (EMBEDDING_MODELS_CATALOG.find((m) => m.id === modelId)?.requiresCoreEmbeddingModule) return null;
  const dataDir = cfg.paths.localModelsDataDir;
  if (readRunningPid(dataDir, "embedding") !== null) return null;
  const outcome = await safely(reclaim, {
    port: cfg.localModels.embeddings.port,
    role: "embedding",
    ownDataDir: dataDir,
    alias: modelId,
    avoidPorts: [cfg.localModels.managed.port],
    move: false,
  });
  return settle(outcome, "embedding");
}

/** A reclaim that fails (a holder lookup that threw) leaves the launch to report the port. */
async function safely(reclaim: Reclaim, req: ReclaimRequest): Promise<ReclaimOutcome> {
  try {
    return await reclaim(req);
  } catch {
    return { kind: "held", why: "the port holder could not be checked" };
  }
}

function settle(outcome: ReclaimOutcome, role: ReclaimRequest["role"]): number | null {
  // A stop is said so the operator knows why a process went away; a holder
  // that stays is reported by the launch's own port-taken message.
  if (outcome.kind === "stopped") process.stdout.write(`${role}: ${outcome.why}\n`);
  return outcome.kind === "adopted" ? outcome.pid : null;
}
