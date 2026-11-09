/**
 * Which model the "new model" hint promotes on this machine. Marking
 * catalog rows `spotlight` on launch day is what turns the hint on; with
 * no row marked this always answers null.
 */

import type { LocalModelDef } from "./models-catalog.js";

/**
 * The largest `spotlight` entry whose `recommendedRamGb` is at most
 * `memoryGb` (the first in list order on a tie), or null when none is.
 * Null as well once any spotlight entry is downloaded: the person
 * already has the new family. Reduced-refusal (`uncensored`) entries are
 * never promoted.
 */
export function spotlightModelFor(
  models: readonly LocalModelDef[],
  memoryGb: number,
  isDownloaded: (def: LocalModelDef) => boolean,
): LocalModelDef | null {
  const spotlight = models.filter((def) => def.spotlight === true);
  if (spotlight.some(isDownloaded)) return null;
  let best: LocalModelDef | null = null;
  for (const def of spotlight) {
    if (def.uncensored === true || def.recommendedRamGb > memoryGb) continue;
    if (best === null || def.recommendedRamGb > best.recommendedRamGb) best = def;
  }
  return best;
}
