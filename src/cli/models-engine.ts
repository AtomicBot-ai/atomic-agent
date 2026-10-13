import { getConfig, ensureUserConfigFileSync, parseUserConfigFile, writeUserConfigFileSync, resetConfigCache } from "../config/index.js";
import { stopEmbeddingDaemon } from "../local-llm/server/daemon-lifecycle.js";
import { selectManagedEngine } from "../local-llm/engine-selection.js";
import { CORE_VERSION, activeCoreVersion, readCoreBackend } from "../local-llm/core/core-state.js";
import { checkCoreUpdate } from "../local-llm/core/core-install.js";
import { isCoreBackendInstalled } from "../local-llm/core/core-backend.js";

/** Write `localModels.managed.engine` to the user config file and drop the cache. */
export function persistManagedEngine(userConfigFile: string, engine: "atomic-core" | "llama-server"): void {
  const file = ensureUserConfigFileSync(userConfigFile);
  file.localModels.managed.engine = engine;
  writeUserConfigFileSync(userConfigFile, parseUserConfigFile(file));
  resetConfigCache();
}

/** A structured surface for both frontends; contains no model-session credentials. */
export async function modelsEngineCommand(args: string[]): Promise<number> {
  const cfg = getConfig();
  const dataDir = cfg.paths.localModelsDataDir;
  const action = args[0] ?? "status";
  if (action === "status" || action === "check") {
    const check = action === "check" ? await checkCoreUpdate(dataDir, fetch, true) : undefined;
    process.stdout.write(JSON.stringify({ engine: cfg.localModels.managed.engine ?? "atomic-core", choiceEnabled: true, installed: isCoreBackendInstalled(dataDir), version: activeCoreVersion(dataDir), compatibleVersion: CORE_VERSION, backend: readCoreBackend(dataDir)?.version ?? null, ...(check ? { check } : {}) }) + "\n");
    return 0;
  }
  if (action !== "atomic-core" && action !== "llama-server") throw new Error("Usage: models engine [status|check|atomic-core|llama-server]");
  await selectManagedEngine(dataDir, cfg.localModels.managed.port, cfg.localModels.embeddings.port,
    () => persistManagedEngine(cfg.paths.userConfigFile, action));
  process.stdout.write(`engine: ${action}\n`);
  return 0;
}

export async function modelsStopEmbedding(): Promise<number> {
  await stopEmbeddingDaemon(getConfig().paths.localModelsDataDir);
  process.stdout.write("embedding model stopped\n");
  return 0;
}
