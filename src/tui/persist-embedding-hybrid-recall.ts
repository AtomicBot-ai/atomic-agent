import {
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { UserConfigFile } from "../config/config-schema.js";

/**
 * Runtime-only gate: hybrid recall follows the live embedding daemon.
 * Does not touch `localModels.embeddings.enabled` (operator master switch).
 */
export function persistMemoryEmbeddingsEnabled(enabled: boolean): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  if (prev.memory.embeddings.enabled === enabled) return;
  const draft: UserConfigFile = {
    ...prev,
    memory: {
      ...prev.memory,
      embeddings: {
        ...prev.memory.embeddings,
        enabled,
      },
    },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}

/**
 * Persist the operator's hybrid-recall intent in one write:
 * `localModels.embeddings` (daemon + model id) and
 * `memory.embeddings.enabled` (runtime hybrid recall gate).
 *
 * The TUI Models tab is the canonical surface — config defaults stay
 * off until the operator downloads and starts an embedding model.
 * Use `persistMemoryEmbeddingsEnabled` when only the daemon state changed
 * (chat restart, reconcile) so the master switch stays on.
 */
export function persistEmbeddingHybridRecall(partial: {
  enabled: boolean;
  modelId?: string | null;
}): void {
  const path = getConfig().paths.userConfigFile;
  const prev = ensureUserConfigFileSync(path);
  const nextEmbeddings: UserConfigFile["localModels"]["embeddings"] = {
    ...prev.localModels.embeddings,
    enabled: partial.enabled,
    ...(partial.modelId !== undefined ? { modelId: partial.modelId } : {}),
  };
  const draft: UserConfigFile = {
    ...prev,
    localModels: {
      ...prev.localModels,
      embeddings: nextEmbeddings,
    },
    memory: {
      ...prev.memory,
      embeddings: {
        ...prev.memory.embeddings,
        enabled: partial.enabled,
      },
    },
  };
  const validated = parseUserConfigFile(draft);
  writeUserConfigFileSync(path, validated);
  resetConfigCache();
}
