import { totalmem } from "node:os";
import {
  getLocalModelDef,
  isKnownLocalModelId,
  LOCAL_MODELS_CATALOG,
  modelDisplayName,
  modelMemoryFit,
  modelMemoryNeedGb,
  recommendedModelFor,
  STARTER_LOCAL_MODEL_ID,
  type LocalModelDef,
  type LocalModelId,
} from "../../local-llm/index.js";

/** Host physical RAM in whole decimal GB, the same measure the panel uses. */
export function hostRamGb(): number {
  return Math.max(1, Math.floor(totalmem() / 1_000_000_000));
}

export interface LocalModelPick {
  id: LocalModelId;
  /** The name a person reads ("Gemma 4 E4B"), the desktop's own (ATO-1410). */
  label: string;
  sizeLabel: string;
  /** "fits" — runs comfortably here; "tight" — over recommended; "over" — under minimum. */
  fit: "fits" | "tight" | "over";
  /** "20 GB RAM": the one need figure both clients print (`modelMemoryNeedGb`). */
  ramLabel: string;
  description: string;
  recommended: boolean;
  /**
   * Reduced-refusal weights. `orderLocalModelPicks` pins these below
   * every other model, `recommendLocalModel` never proposes one, and the
   * row renders `tag` in the warn tone.
   */
  uncensored: boolean;
  /** The catalog's warning label for the row, e.g. "Use at your own risk". */
  tag?: string;
  /** What an uncensored model is, in one sentence; shown instead of the description. */
  note?: string;
  /**
   * ATO-1045: the no-key path. The starter model, pinned first: it
   * answers within a minute of the download, and the best model for this
   * machine (`followedBy`) downloads in the background once it lands.
   */
  quickStart?: boolean;
  followedBy?: LocalModelId;
}

export interface LocalModelPicksOptions {
  /**
   * Offer the starter as the first row (ATO-1045). Only the first-run
   * picker asks for it; a model panel lists the catalog as it is.
   */
  quickStart?: boolean;
}

/**
 * Ceiling on the *recommended* download, in GB. The catalog goes up to
 * 22 GB, and a machine with the RAM to run that can still be an hour
 * from its first answer. A first run should reach a working agent, not
 * the best possible one — the bigger models stay one row away.
 */
export const FIRST_RUN_MAX_DOWNLOAD_GB = 8;

/**
 * The catalog as first-run rows: size, what it needs, and one
 * recommendation.
 */
export function buildLocalModelPicks(
  ramGb: number,
  catalog: readonly LocalModelDef[] = LOCAL_MODELS_CATALOG,
  options: LocalModelPicksOptions = {},
): LocalModelPick[] {
  const recommendedId = recommendLocalModel(ramGb, catalog);
  const quick = options.quickStart
    ? quickStartFor(ramGb, catalog, recommendedId)
    : null;
  return catalog.map((def) => ({
    id: def.id,
    label: modelDisplayName(def),
    sizeLabel: def.sizeLabel,
    fit: fitFor(def, ramGb),
    ramLabel: `${modelMemoryNeedGb(def)} GB RAM`,
    description: def.description,
    recommended: def.id === recommendedId,
    uncensored: def.uncensored === true,
    // Only an uncensored entry's tag is a warning the first run must
    // show; the marketing tags ("New", "Recommended") stay off this
    // screen — the picker computes its own recommendation from RAM.
    tag: def.uncensored === true ? def.tag : undefined,
    ...(def.uncensored === true && def.note !== undefined ? { note: def.note } : {}),
    ...(quick && def.id === quick.id
      ? {
          quickStart: true,
          followedBy: quick.followedBy,
          description: `no key, answers in a minute; ${followUpName(catalog, quick.followedBy)} follows in the background`,
        }
      : {}),
  }));
}

/**
 * The starter row, when it is worth offering: the catalog has it, this
 * machine runs it comfortably, and a better model exists to follow it.
 * The follow-up shown is the first-run recommendation; the one actually
 * fetched is decided again when the starter lands (`startModelUpgrade`),
 * with the GPU and the disk in view, and may be bigger.
 */
export function quickStartFor(
  ramGb: number,
  catalog: readonly LocalModelDef[],
  recommendedId: LocalModelId | null,
): { id: LocalModelId; followedBy: LocalModelId } | null {
  const starter = catalog.find((def) => def.id === STARTER_LOCAL_MODEL_ID);
  if (!starter || starter.recommendedRamGb > ramGb) return null;
  if (!recommendedId || recommendedId === starter.id) return null;
  return { id: starter.id, followedBy: recommendedId };
}

/**
 * The best first model for this machine: the catalog's own rule
 * (`recommendedModelFor`, best-ranked well-known model that runs
 * comfortably) under the download ceiling. When no ranked model
 * qualifies: the largest one that runs comfortably under the ceiling,
 * then anything that runs comfortably, then the smallest model in the
 * catalog — something that runs beats something that was recommended.
 */
export function recommendLocalModel(
  ramGb: number,
  catalog: readonly LocalModelDef[] = LOCAL_MODELS_CATALOG,
): LocalModelId | null {
  // Reduced-refusal ("uncensored") entries are never candidates — not
  // for the comfortable pick and not for any fallback. They stay in the
  // list, tagged and pinned last, but choosing one has to be the
  // operator's own act; the recommendation star must never point at one.
  const candidates = catalog.filter((def) => def.uncensored !== true);
  if (candidates.length === 0) return null;
  const ranked = recommendedModelFor(ramGb, {
    catalog: candidates,
    maxDownloadGb: FIRST_RUN_MAX_DOWNLOAD_GB,
  });
  if (ranked) return ranked.id;
  const comfortable = candidates.filter((def) => def.recommendedRamGb <= ramGb);
  const quick = comfortable.filter(
    (def) => def.fileSizeGb <= FIRST_RUN_MAX_DOWNLOAD_GB,
  );
  const largest = (defs: readonly LocalModelDef[]): LocalModelDef =>
    defs.reduce((best, def) => (def.fileSizeGb > best.fileSizeGb ? def : best));
  if (quick.length > 0) return largest(quick).id;
  if (comfortable.length > 0) {
    return comfortable.reduce((best, def) =>
      def.fileSizeGb < best.fileSizeGb ? def : best,
    ).id;
  }
  return candidates.reduce((best, def) =>
    def.fileSizeGb < best.fileSizeGb ? def : best,
  ).id;
}

/** The shared verdict (`modelMemoryFit`), in this screen's own three words. */
function fitFor(def: LocalModelDef, ramGb: number): LocalModelPick["fit"] {
  const fit = modelMemoryFit(def, ramGb);
  return fit === "comfortable" ? "fits" : fit;
}

function followUpName(
  catalog: readonly LocalModelDef[],
  id: LocalModelId,
): string {
  const def = catalog.find((d) => d.id === id);
  return def ? modelDisplayName(def) : id;
}

/**
 * The escape hatch under the curated list. It is a row rather than a
 * hotkey because an operator who came here to fetch a specific model has
 * to be able to see that the option exists — the curated set is a
 * recommendation, not the boundary of what runs.
 */
export const HUGGING_FACE_ROW_LABEL = "Add a model from Hugging Face…";
export const HUGGING_FACE_ROW_NOTE =
  "paste an owner/repo id or a huggingface.co URL";

export type LocalPickRow =
  { kind: "model"; pick: LocalModelPick } | { kind: "hugging_face" };

/**
 * The picker's rows in cursor order. The Hugging Face row is last and is
 * counted in the cursor length, so `moveOnboardingCursor` wraps from it
 * back to the first recommendation.
 */
export function buildLocalPickRows(
  picks: readonly LocalModelPick[],
): LocalPickRow[] {
  return [
    ...picks.map((pick): LocalPickRow => ({ kind: "model", pick })),
    { kind: "hugging_face" },
  ];
}

/**
 * What the download screen calls the model it is pulling. A curated id
 * is already the name people use for it; a `custom-` slug is not — it
 * carries the owner, the repo and the quant, and reads as machinery. The
 * bare filename says the same thing in the space a curated id takes.
 */
export function describeDownloadingModel(id: string | null): string {
  if (!id) return "the model";
  if (!isKnownLocalModelId(id)) return id;
  const def = getLocalModelDef(id);
  if (def.family !== "custom") return modelDisplayName(def);
  return def.filename.replace(/\.gguf$/i, "");
}

/** Rows ordered for the first run: the recommendation first, then by size. */
export function orderLocalModelPicks(
  picks: readonly LocalModelPick[],
): LocalModelPick[] {
  const ordered = [...picks].sort((a, b) => {
    // ATO-1045: the no-key starter row leads, the recommendation follows it.
    if (!!a.quickStart !== !!b.quickStart) return a.quickStart ? -1 : 1;
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const fitRank = { fits: 0, tight: 1, over: 2 } as const;
    if (fitRank[a.fit] !== fitRank[b.fit])
      return fitRank[a.fit] - fitRank[b.fit];
    return a.sizeLabel.localeCompare(b.sizeLabel, "en", { numeric: true });
  });
  // Explicit pinning rule, applied AFTER the usual ordering: uncensored
  // entries always sink below every other model, whatever their fit or
  // size says — reaching one means scrolling past the safe defaults.
  // (The Hugging Face row still comes after them; see buildLocalPickRows.)
  return [
    ...ordered.filter((pick) => !pick.uncensored),
    ...ordered.filter((pick) => pick.uncensored),
  ];
}
