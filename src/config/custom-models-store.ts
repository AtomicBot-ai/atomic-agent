/**
 * Add / remove user-added Hugging Face models in the user config, and
 * keep the catalog registry in sync. Shared by the CLI (`models add`)
 * and the TUI (`/models add`) so both surfaces write the same shape.
 */

import type { LocalModelDef } from "../local-llm/models-catalog.js";
import { setCustomLocalModels } from "../local-llm/models-catalog.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { parseUserConfigFile } from "./config-schema.js";
import { getConfig, resetConfigCache } from "./config-cache.js";

function writeCustomModels(defs: LocalModelDef[]): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  // Dropping the active model would leave `managed.modelId` dangling and
  // the file would fail its own validation on the next read.
  const activeId = prev.localModels.managed.modelId;
  const activeSurvives =
    activeId === null ||
    !activeId.startsWith("custom-") ||
    defs.some((m) => m.id === activeId);
  const validated = parseUserConfigFile({
    ...prev,
    localModels: {
      ...prev.localModels,
      customModels: defs,
      managed: {
        ...prev.localModels.managed,
        modelId: activeSurvives ? activeId : null,
      },
    },
  });
  writeUserConfigFileSync(path, validated);
  // Registry first, cache second: a caller that reads the catalog before
  // the next `getConfig()` still sees the new entry.
  setCustomLocalModels(validated.localModels.customModels);
  resetConfigCache();
}

/**
 * Persist `def`, replacing any existing entry with the same id (re-adding
 * the same repo+file is an idempotent refresh, not a duplicate).
 */
export function addCustomModel(def: LocalModelDef): void {
  const prev = getConfig();
  const kept = prev.localModels.customModels.filter((m) => m.id !== def.id);
  writeCustomModels([...kept, def]);
}

/** Drop a custom model from the config. Returns false if it wasn't there. */
export function removeCustomModel(id: string): boolean {
  const prev = getConfig();
  const kept = prev.localModels.customModels.filter((m) => m.id !== id);
  if (kept.length === prev.localModels.customModels.length) return false;
  writeCustomModels(kept);
  return true;
}
