/**
 * Write the person's own sampling for one model (ATO-2482). An added
 * model keeps it on its own entry (`localModels.customModels[].sampling`);
 * any other id goes to `localModels.modelSamplingOverrides`. `null`
 * drops it, back to the model's default. The whole file is validated
 * before it is written, as `custom-models-store.ts` does.
 */

import {
  ensureUserConfigFileSync,
  writeUserConfigFileSync,
} from "./config-file.js";
import { parseUserConfigFile } from "./config-schema.js";
import { getConfig, resetConfigCache } from "./config-cache.js";
import { setCustomLocalModels } from "../local-llm/catalog/models-catalog.js";
import {
  isEmptyLocalModelSampling,
  type LocalModelSampling,
} from "../local-llm/catalog/model-sampling-sets.js";

/** The person's set for `id`, or `null` when the model runs on its default. */
export function readModelSamplingSetting(id: string): LocalModelSampling | null {
  const user = ensureUserConfigFileSync(getConfig().paths.userConfigFile);
  const fromMap = user.localModels.modelSamplingOverrides?.[id];
  if (fromMap) return fromMap;
  const custom = user.localModels.customModels.find((m) => m.id === id);
  return custom?.sampling ?? null;
}

export function writeModelSamplingSetting(
  id: string,
  sampling: LocalModelSampling | null,
): void {
  const path = getConfig().paths.userConfigFile;
  const previous = ensureUserConfigFileSync(path);
  const keep = sampling !== null && !isEmptyLocalModelSampling(sampling) ? sampling : null;
  const isCustom = previous.localModels.customModels.some((m) => m.id === id);
  const customModels = previous.localModels.customModels.map((m) => {
    if (m.id !== id) return m;
    const { sampling: _old, ...rest } = m;
    return keep ? { ...rest, sampling: keep } : rest;
  });
  const overrides = { ...(previous.localModels.modelSamplingOverrides ?? {}) };
  // An added model's set lives on its entry; a stale map entry for the
  // same id would shadow it, so it goes either way.
  delete overrides[id];
  if (keep && !isCustom) overrides[id] = keep;
  const { modelSamplingOverrides: _map, ...localModels } = previous.localModels;
  const validated = parseUserConfigFile({
    ...previous,
    localModels: {
      ...localModels,
      customModels,
      ...(Object.keys(overrides).length > 0 ? { modelSamplingOverrides: overrides } : {}),
    },
  });
  writeUserConfigFileSync(path, validated);
  if (isCustom) setCustomLocalModels(validated.localModels.customModels);
  resetConfigCache();
}
