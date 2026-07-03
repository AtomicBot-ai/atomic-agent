import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
  type UserConfigFile,
} from "../config/index.js";

import { RuntimeApiError } from "./runtime-api-error.js";

export interface ConfigFileResult {
  path: string;
  config: UserConfigFile;
}

/**
 * Read the current user config file, creating a default file on first
 * read if one does not yet exist. Uses the `getConfig()` singleton (the
 * one documented global exception) to resolve the file path.
 */
export function getConfigFile(): ConfigFileResult {
  const path = getConfig().paths.userConfigFile;
  const file = ensureUserConfigFileSync(path);
  return { path, config: file };
}

/**
 * Shallow-merge a patch into the user config file and persist atomically.
 * The merged payload is revalidated through `parseUserConfigFile` so
 * misconfigured values never land on disk. `resetConfigCache()` is called
 * so subsequent reads see the new values; in-flight agent loops keep the
 * previously-loaded config until restart.
 *
 * Only `localModels`, `log`, and `agent` are merged — matching the
 * existing HTTP contract.
 */
export function patchConfigFile(
  patch: Partial<UserConfigFile>,
): ConfigFileResult {
  const path = getConfig().paths.userConfigFile;
  const current = ensureUserConfigFileSync(path);
  const merged = mergeUserConfig(current, patch);
  let next: UserConfigFile;
  try {
    next = parseUserConfigFile(merged);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      throw new RuntimeApiError(err.message, "invalid_request");
    }
    throw err;
  }
  writeUserConfigFileSync(path, next);
  resetConfigCache();
  return { path, config: next };
}

function mergeUserConfig(
  current: UserConfigFile,
  patch: Partial<UserConfigFile>,
): Record<string, unknown> {
  return {
    version: current.version,
    localModels: { ...current.localModels, ...(patch.localModels ?? {}) },
    log: { ...current.log, ...(patch.log ?? {}) },
    agent: { ...current.agent, ...(patch.agent ?? {}) },
  };
}
