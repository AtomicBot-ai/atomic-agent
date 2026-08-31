import { totalmem } from "node:os";
import {
  getLocalModelDef,
  isKnownLocalModelId,
  LOCAL_MODELS_CATALOG,
  type LocalModelDef,
  type LocalModelId,
} from "../../local-llm/index.js";

/** Host physical RAM in whole decimal GB, the same measure the panel uses. */
export function hostRamGb(): number {
  return Math.max(1, Math.floor(totalmem() / 1_000_000_000));
}

export interface LocalModelPick {
  id: LocalModelId;
  label: string;
  sizeLabel: string;
  /** "fits" — runs comfortably here; "tight" — over recommended; "over" — under minimum. */
  fit: "fits" | "tight" | "over";
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
): LocalModelPick[] {
  const recommendedId = recommendLocalModel(ramGb, catalog);
  return catalog.map((def) => ({
    id: def.id,
    label: def.id,
    sizeLabel: def.sizeLabel,
    fit: fitFor(def, ramGb),
    ramLabel: `${def.recommendedRamGb} GB RAM`,
    description: def.description,
    recommended: def.id === recommendedId,
    uncensored: def.uncensored === true,
    // Only an uncensored entry's tag is a warning the first run must
    // show; the marketing tags ("New", "Recommended") stay off this
    // screen — the picker computes its own recommendation from RAM.
    tag: def.uncensored === true ? def.tag : undefined,
  }));
}

/**
 * The best first model for this machine: the largest one that runs
 * comfortably *and* stays under the download ceiling. Falling back, in
 * order: anything that runs comfortably, then the smallest model in the
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

function fitFor(def: LocalModelDef, ramGb: number): LocalModelPick["fit"] {
  if (def.recommendedRamGb <= ramGb) return "fits";
  if (def.minRamGb <= ramGb) return "tight";
  return "over";
}

/**
 * The escape hatch under the curated list. It is a row rather than a
 * hotkey because an operator who came here to fetch a specific model has
 * to be able to see that the option exists — the curated set is a
 * recommendation, not the boundary of what runs.
 */
export const HUGGING_FACE_ROW_LABEL = "Add a model from Hugging Face…";
export const HUGGING_FACE_ROW_NOTE = "paste an owner/repo id or a huggingface.co URL";

export type LocalPickRow =
  | { kind: "model"; pick: LocalModelPick }
  | { kind: "hugging_face" };

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
  if (def.family !== "custom") return def.id;
  return def.filename.replace(/\.gguf$/i, "");
}

/** Rows ordered for the first run: the recommendation first, then by size. */
export function orderLocalModelPicks(picks: readonly LocalModelPick[]): LocalModelPick[] {
  const ordered = [...picks].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const fitRank = { fits: 0, tight: 1, over: 2 } as const;
    if (fitRank[a.fit] !== fitRank[b.fit]) return fitRank[a.fit] - fitRank[b.fit];
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
