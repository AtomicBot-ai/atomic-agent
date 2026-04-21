import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
  writeUserConfigFileSync,
} from "../config/index.js";
import type { UserConfigFile } from "../config/index.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * `GET /api/config` — return the current user config file contents,
 * creating a default file on first read if one does not yet exist.
 */
export function createGetConfigHandler(): HttpHandler {
  return async (_req, res) => {
    const path = getConfig().paths.userConfigFile;
    const file = ensureUserConfigFileSync(path);
    sendJson(res, 200, { path, config: file });
  };
}

/**
 * `PATCH /api/config` — shallow-merge the request body into the user
 * config file and persist atomically. The merged payload is revalidated
 * through `parseUserConfigFile` so misconfigured values never land on
 * disk. We call `resetConfigCache()` so subsequent reads see the new
 * values; in-flight agent loops still use the previously-loaded config.
 */
export function createPatchConfigHandler(): HttpHandler {
  return async (req, res) => {
    let body: Partial<UserConfigFile>;
    try {
      body = await readJsonBody<Partial<UserConfigFile>>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const path = getConfig().paths.userConfigFile;
    const current = ensureUserConfigFileSync(path);
    const merged = mergeUserConfig(current, body);
    let next: UserConfigFile;
    try {
      next = parseUserConfigFile(merged);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    writeUserConfigFileSync(path, next);
    resetConfigCache();
    sendJson(res, 200, { path, config: next });
  };
}

function mergeUserConfig(
  current: UserConfigFile,
  patch: Partial<UserConfigFile>,
): Record<string, unknown> {
  return {
    version: current.version,
    llama: { ...current.llama, ...(patch.llama ?? {}) },
    log: { ...current.log, ...(patch.log ?? {}) },
    agent: { ...current.agent, ...(patch.agent ?? {}) },
  };
}
