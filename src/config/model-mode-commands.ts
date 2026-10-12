import { getConfig, resetConfigCache } from "./config-cache.js";
import { ensureUserConfigFileSync, writeUserConfigFileSync } from "./config-file.js";
import { ConfigValidationError } from "./config-validation-error.js";
import { readLlmBlockOrDefault } from "./llm-provider-commands.js";
import { parseModelMode, type ModelMode } from "./model-mode.js";

/** null removes this override; it is not a third stored mode. */
export function setModelModeInConfig(input: {
  providerId?: string;
  modelId?: string;
  mode: ModelMode | null;
}): void {
  const mode = parseModelMode(input.mode, "modelMode");
  if (input.modelId !== undefined && !input.modelId.trim()) {
    throw new ConfigValidationError("modelId", "expected non-empty model id");
  }
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  const llm = readLlmBlockOrDefault(file);
  const id = input.providerId ?? llm.activeTextProvider;
  if (!llm.providers.some((provider) => provider.id === id)) {
    throw new ConfigValidationError("providerId", `provider ${JSON.stringify(id)} is not configured`);
  }
  const providers = llm.providers.map((provider) => {
    if (provider.id !== id) return provider;
    const next = { ...provider };
    if (input.modelId === undefined) {
      if (mode === undefined) delete next.modelMode;
      else next.modelMode = mode;
    } else {
      const models = new Map(Object.entries(provider.modelModes ?? {}));
      if (mode === undefined) models.delete(input.modelId);
      else models.set(input.modelId, mode);
      if (models.size === 0) delete next.modelModes;
      else next.modelModes = Object.fromEntries(models);
    }
    return next;
  });
  writeUserConfigFileSync(path, { ...file, llm: { ...llm, providers } });
  resetConfigCache();
}
