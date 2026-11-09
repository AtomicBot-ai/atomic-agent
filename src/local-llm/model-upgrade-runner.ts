/**
 * ATO-1043 / ATO-1045 — read the machine and the config once, decide the
 * upgrade, and start its background download. Shared by
 * `atomic-agent models recommend|upgrade` and the TUI, which starts it
 * when the starter model lands (the no-key path).
 */

import { getConfig } from "../config/index.js";
import {
  decideModelUpgrade,
  recommendModelTiers,
  type MachineForModels,
  type ModelTiers,
  type ModelUpgradeDecision,
} from "./catalog/model-upgrade.js";
import { listLocalModels } from "./catalog/models-catalog.js";
import { probeMachineForModels } from "./backend/machine-for-models.js";
import {
  downloadJobId,
  isDownloadJobLive,
  readDownloadJob,
} from "./downloads/download-jobs.js";
import { spawnDownloadWorker } from "./downloads/download-spawn.js";
import { isModelDownloaded } from "./downloads/model-installer.js";

export interface RecommendSnapshot {
  machine: MachineForModels;
  tiers: ModelTiers;
  decision: ModelUpgradeDecision;
  activeModelId: string | null;
}

/** Everything both subcommands print, read once from config and the machine. */
export async function readRecommendSnapshot(
  probe: typeof probeMachineForModels = probeMachineForModels,
): Promise<RecommendSnapshot> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  const managed = cfg.localModels.mode === "managed";
  const machine = await probe({
    dataDir,
    engine: cfg.localModels.managed.engine,
    configuredDevice: cfg.localModels.managed.device,
  });
  const activeModelId = managed ? cfg.localModels.managed.modelId : null;
  const active = cfg.llm?.activeTextProvider;
  const downloadedIds = listLocalModels()
    .filter((def) => isModelDownloaded(dataDir, def))
    .map((def) => def.id);
  return {
    machine,
    tiers: recommendModelTiers(machine),
    decision: decideModelUpgrade({
      machine,
      activeModelId,
      downloadedIds,
      managed,
      cloudActive: !!active && active !== "local-llama",
    }),
    activeModelId,
  };
}

export interface StartedUpgrade {
  snapshot: RecommendSnapshot;
  /** The background job, when the decision was to download. */
  job: { id: string; pid: number; started: boolean } | null;
}

/**
 * Decide, and start the quality model's background download when the
 * decision says so (a live job for it is joined, not raced). Shared by
 * `models upgrade` and the TUI's no-key path (ATO-1045).
 */
export async function startModelUpgrade(
  options: { dryRun?: boolean; probe?: typeof probeMachineForModels } = {},
): Promise<StartedUpgrade> {
  const snapshot = await readRecommendSnapshot(options.probe);
  const d = snapshot.decision;
  if (d.action !== "download" || options.dryRun) return { snapshot, job: null };
  const dataDir = getConfig().paths.localModelsDataDir;
  const existing = readDownloadJob(dataDir, downloadJobId("chat", d.model.id));
  if (isDownloadJobLive(existing)) {
    return { snapshot, job: { id: existing.id, pid: existing.pid, started: false } };
  }
  const res = spawnDownloadWorker({
    dataDir,
    kind: "chat",
    modelId: d.model.id,
    mode: d.model.supportsVision ? "with-mmproj" : "gguf-only",
  });
  return {
    snapshot,
    job: { id: res.job.id, pid: res.job.pid, started: res.outcome !== "already-running" },
  };
}

