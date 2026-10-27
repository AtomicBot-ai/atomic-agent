/**
 * The one rule for "which local model should this machine get": the
 * best-ranked well-known model (`LocalModelDef.recommendRank`) that runs
 * comfortably in the given memory. It replaces "the biggest model that
 * fits", which ranked by size alone and so put a less common 30B ahead
 * of the popular families. The first-run picker and the desktop both
 * follow this order.
 */

import {
  LOCAL_MODELS_CATALOG,
  type LocalModelDef,
} from "./models-catalog.js";

export interface RecommendedModelOptions {
  /** Defaults to the curated catalog. */
  catalog?: readonly LocalModelDef[];
  /**
   * Skip entries whose weights download is larger than this, in GB. The
   * first-run picker sets it so a fresh install reaches a working agent
   * quickly; omitted, size does not matter.
   */
  maxDownloadGb?: number;
}

/**
 * The best-ranked model whose `recommendedRamGb` is at most `memoryGb`,
 * or null when none is. Reduced-refusal (`uncensored`) and unranked
 * entries are never returned: choosing one has to be the operator's own
 * act.
 */
export function recommendedModelFor(
  memoryGb: number,
  options: RecommendedModelOptions = {},
): LocalModelDef | null {
  const catalog = options.catalog ?? LOCAL_MODELS_CATALOG;
  const maxDownloadGb = options.maxDownloadGb ?? Number.POSITIVE_INFINITY;
  let best: LocalModelDef | null = null;
  for (const def of catalog) {
    const rank = def.recommendRank;
    if (rank === undefined || def.uncensored === true) continue;
    if (def.recommendedRamGb > memoryGb) continue;
    if (def.fileSizeGb > maxDownloadGb) continue;
    if (best === null || rank < (best.recommendRank ?? Infinity)) best = def;
  }
  return best;
}
