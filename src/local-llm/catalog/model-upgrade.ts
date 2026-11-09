/**
 * ATO-1043 / ATO-15 — which "big" model this machine should end up on,
 * and whether to fetch it in the background now.
 *
 * Zero-setup (ATO-978): the first chat answers on the 1.3 GB starter
 * model (ATO-1041/1042). The model the machine can really carry is
 * downloaded behind it and offered once it is on disk. This file is the
 * pure half of that: given what the machine has (memory, GPU memory,
 * free disk) and what is already on disk, it names three tiers
 * (fast / balanced / quality) and decides the upgrade.
 *
 * It reuses the catalog's own ranking (`recommendedModelFor`, #852):
 * the best-ranked well-known model that runs comfortably. Two limits
 * are added on top of RAM, both from ATO-15:
 *  - GPU memory: where the machine reports a discrete GPU, the quality
 *    tier must fit in it, or it would run on the CPU at a crawl.
 *  - Free disk: the weights plus headroom must fit on the disk.
 *
 * No IO here; `machine-for-models.ts` gathers the inputs.
 */

import {
  LOCAL_MODELS_CATALOG,
  STARTER_LOCAL_MODEL_ID,
  type LocalModelDef,
} from "./models-catalog.js";
import { recommendedModelFor } from "./recommended-model.js";

/** What the recommendation needs to know about the machine. */
export interface MachineForModels {
  /** Physical RAM, decimal GB. */
  ramGb: number;
  /**
   * GPU memory the weights would load into, decimal GB
   * (`resolveGpuBudgetGb`): a share of RAM on Apple Silicon, the
   * device's VRAM elsewhere. `null` when there is no usable GPU.
   */
  gpuBudgetGb: number | null;
  /** Free space on the disk holding the models, decimal GB; `null` when unknown. */
  freeDiskGb: number | null;
  /**
   * The host has no GPU at all (Linux / Windows without one). The model
   * then runs on the CPU, where a big model answers too slowly to be an
   * upgrade.
   */
  cpuOnly: boolean;
}

/**
 * Same ceiling as the TUI first-run picker (`FIRST_RUN_MAX_DOWNLOAD_GB`):
 * the "balanced" tier is the model a person waits for, so it stays a
 * download of minutes, not an hour.
 */
export const BALANCED_MAX_DOWNLOAD_GB = 8;

/**
 * On a machine with no GPU the "quality" tier stays at mid-size weights:
 * beyond this a CPU answers at a word or two a second. Proposal for
 * Nadya in the PR; change here if the measurement says otherwise.
 */
export const CPU_ONLY_MAX_MODEL_GB = 6;

/**
 * Share of the GPU memory the weights may take. The rest is the KV
 * cache and the compute buffers; a model filling the whole budget loads
 * but spills its context to the CPU.
 */
export const GPU_WEIGHTS_SHARE = 0.85;

/** Disk left free after the download, decimal GB. */
export const DISK_HEADROOM_GB = 2;

/** Bytes on disk of a model with its projector, in GB. */
export function modelDownloadGb(def: LocalModelDef): number {
  return def.fileSizeGb + (def.supportsVision ? (def.mmprojFileSizeGb ?? 0) : 0);
}

export interface ModelTiers {
  /** The smallest ranked model that runs comfortably: answers first. */
  fast: LocalModelDef | null;
  /** Best ranked under the first-run download ceiling. */
  balanced: LocalModelDef | null;
  /** Best ranked this machine carries: the "big" model of ATO-1043. */
  quality: LocalModelDef | null;
}

export interface ModelTierOptions {
  catalog?: readonly LocalModelDef[];
}

/**
 * The catalog entries this machine can take at all: ranked, not
 * reduced-refusal, comfortable in RAM, inside the GPU and disk limits.
 */
export function modelsThisMachineCarries(
  machine: MachineForModels,
  options: ModelTierOptions = {},
): LocalModelDef[] {
  const catalog = options.catalog ?? LOCAL_MODELS_CATALOG;
  return catalog.filter((def) => {
    if (def.recommendRank === undefined || def.uncensored === true) return false;
    if (def.recommendedRamGb > machine.ramGb) return false;
    const weights = def.fileSizeGb;
    if (machine.cpuOnly && weights > CPU_ONLY_MAX_MODEL_GB) return false;
    if (
      machine.gpuBudgetGb !== null &&
      weights > machine.gpuBudgetGb * GPU_WEIGHTS_SHARE
    ) {
      return false;
    }
    if (
      machine.freeDiskGb !== null &&
      modelDownloadGb(def) + DISK_HEADROOM_GB > machine.freeDiskGb
    ) {
      return false;
    }
    return true;
  });
}

/** ATO-15: fast / balanced / quality for this machine. */
export function recommendModelTiers(
  machine: MachineForModels,
  options: ModelTierOptions = {},
): ModelTiers {
  const carried = modelsThisMachineCarries(machine, options);
  if (carried.length === 0) return { fast: null, balanced: null, quality: null };
  // recommendedModelFor checks RAM again; the list is already filtered.
  const quality = recommendedModelFor(machine.ramGb, { catalog: carried });
  const balanced =
    recommendedModelFor(machine.ramGb, {
      catalog: carried,
      maxDownloadGb: BALANCED_MAX_DOWNLOAD_GB,
    }) ?? quality;
  const fast = carried.reduce((best, def) =>
    def.fileSizeGb < best.fileSizeGb ? def : best,
  );
  return { fast, balanced, quality };
}

export type ModelUpgradeDecision =
  /** Fetch `model` in the background; offer it when it lands. */
  | { action: "download"; model: LocalModelDef }
  /** `model` is already on disk: offer the switch now. */
  | { action: "switch"; model: LocalModelDef }
  | {
      action: "none";
      why:
        /** The active model is already the best this machine carries. */
        | "already_best"
        /** Nothing in the catalog runs comfortably here. */
        | "nothing_fits"
        /** The local engine is not the managed one (Ollama, LM Studio, a URL). */
        | "not_managed"
        /** A cloud model answers: the person chose cloud. */
        | "not_wanted"
        /** The active model is one the person picked outside the ranking (their own GGUF). */
        | "own_choice";
    };

export interface ModelUpgradeInput {
  machine: MachineForModels;
  /** `localModels.managed.modelId` when the managed engine is active, else null. */
  activeModelId: string | null;
  /** Ids of chat models already on disk. */
  downloadedIds: readonly string[];
  /** `localModels.mode` is "managed". */
  managed: boolean;
  /** A cloud model is the active route: the person chose cloud. */
  cloudActive: boolean;
  catalog?: readonly LocalModelDef[];
}

/**
 * Whether to fetch (or offer) a bigger local model. Only ever moves up:
 * the target must rank better than the active model, and the starter
 * (unranked) is below every ranked one. A person on a cloud model or on
 * their own server is left alone.
 */
export function decideModelUpgrade(
  input: ModelUpgradeInput,
): ModelUpgradeDecision {
  if (!input.managed) return { action: "none", why: "not_managed" };
  if (input.cloudActive) return { action: "none", why: "not_wanted" };
  const catalog = input.catalog ?? LOCAL_MODELS_CATALOG;
  const target = recommendModelTiers(input.machine, { catalog }).quality;
  if (!target) return { action: "none", why: "nothing_fits" };
  const activeId = input.activeModelId;
  const active =
    activeId === null ? undefined : catalog.find((def) => def.id === activeId);
  // Their own Hugging Face model, or an unranked one they picked by hand:
  // not ours to replace. The starter is the one unranked model we do move off.
  if (
    activeId !== null &&
    !isStarterModel(activeId) &&
    (active === undefined || active.recommendRank === undefined)
  ) {
    return { action: "none", why: "own_choice" };
  }
  if (active && !isBelow(active, target)) {
    return { action: "none", why: "already_best" };
  }
  return input.downloadedIds.includes(target.id)
    ? { action: "switch", model: target }
    : { action: "download", model: target };
}

/** `a` ranks below `b`. Unranked entries (the starter, custom) rank below all. */
function isBelow(a: LocalModelDef, b: LocalModelDef): boolean {
  if (a.id === b.id) return false;
  const ra = a.recommendRank ?? Number.POSITIVE_INFINITY;
  const rb = b.recommendRank ?? Number.POSITIVE_INFINITY;
  return rb < ra;
}

/** The model the first chat runs on before the upgrade lands. */
export function isStarterModel(id: string | null | undefined): boolean {
  return id === STARTER_LOCAL_MODEL_ID;
}
