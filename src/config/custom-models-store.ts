/**
 * Write the operator's own Hugging Face models into the user config and
 * keep the catalog registry in step. Ported from PR #38 by
 * sachin-detrax; the ordering below (registry first, cache second) is
 * its observation, and it matters — the first-run flow adds a model and
 * asks the orchestrator to pull it in the same tick.
 */

import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { parseUserConfigFile } from "./config-schema.js";
import { getConfig, resetConfigCache } from "./config-cache.js";
import { setCustomLocalModels } from "../local-llm/models-catalog.js";
import type { LocalModelDef } from "../local-llm/models-catalog.js";

function writeCustomModels(defs: readonly LocalModelDef[]): void {
  const path = getConfig().paths.userConfigFile;
  const previous = ensureUserConfigFileSync(path);
  // Dropping the model that is currently active would leave
  // `managed.modelId` dangling, and the file would then fail its own
  // validation on the next read.
  const activeId = previous.localModels.managed.modelId;
  const activeSurvives =
    activeId === null ||
    !activeId.startsWith("custom-") ||
    defs.some((def) => def.id === activeId);
  const validated = parseUserConfigFile({
    ...previous,
    localModels: {
      ...previous.localModels,
      customModels: [...defs],
      managed: {
        ...previous.localModels.managed,
        modelId: activeSurvives ? activeId : null,
      },
    },
  });
  writeUserConfigFileSync(path, validated);
  setCustomLocalModels(validated.localModels.customModels);
  resetConfigCache();
}

/**
 * Persist `def`, replacing any entry with the same id — re-adding the
 * same repo and file is a refresh, not a duplicate.
 */
export function addCustomModel(def: LocalModelDef): void {
  const path = getConfig().paths.userConfigFile;
  const previous = ensureUserConfigFileSync(path);
  const kept = previous.localModels.customModels.filter((m) => m.id !== def.id);
  writeCustomModels([...kept, def]);
}

/** Drop one. Returns `false` when there was nothing by that id. */
export function removeCustomModel(id: string): boolean {
  const path = getConfig().paths.userConfigFile;
  const previous = ensureUserConfigFileSync(path);
  const kept = previous.localModels.customModels.filter((m) => m.id !== id);
  if (kept.length === previous.localModels.customModels.length) return false;
  writeCustomModels(kept);
  return true;
}
