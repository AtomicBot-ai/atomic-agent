import { totalmem } from "node:os";
import { LOCAL_MODELS_CATALOG, type LocalModelDef, type LocalModelId } from "../../local-llm/index.js";

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
  if (catalog.length === 0) return null;
  const comfortable = catalog.filter((def) => def.recommendedRamGb <= ramGb);
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
  return catalog.reduce((best, def) =>
    def.fileSizeGb < best.fileSizeGb ? def : best,
  ).id;
}

function fitFor(def: LocalModelDef, ramGb: number): LocalModelPick["fit"] {
  if (def.recommendedRamGb <= ramGb) return "fits";
  if (def.minRamGb <= ramGb) return "tight";
  return "over";
}

/** Rows ordered for the first run: the recommendation first, then by size. */
export function orderLocalModelPicks(picks: readonly LocalModelPick[]): LocalModelPick[] {
  return [...picks].sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const fitRank = { fits: 0, tight: 1, over: 2 } as const;
    if (fitRank[a.fit] !== fitRank[b.fit]) return fitRank[a.fit] - fitRank[b.fit];
    return a.sizeLabel.localeCompare(b.sizeLabel, "en", { numeric: true });
  });
}
