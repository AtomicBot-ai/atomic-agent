import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
} from "../config/index.js";
import type { UserConfigFile } from "../config/index.js";
import {
  isSafeConfigPath,
  readRawConfigTree,
  writeRawUserConfigFileSync,
} from "../config/config-paths.js";

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
 * `PATCH /api/config` — deep-merge the request body into the user config
 * file on disk and persist atomically.
 *
 * The merge starts from the raw file, not the defaulted config: plain
 * objects merge key by key, arrays and scalars replace, and every key the
 * patch does not name keeps its on-disk value — `llm.providers`,
 * `mcp.servers`, `skills.disabled`, an `analytics.enabled: false`
 * opt-out. The merged tree is revalidated through `parseUserConfigFile`
 * before anything is written, so misconfigured values never land on
 * disk. We call `resetConfigCache()` so subsequent reads see the new
 * values; in-flight agent loops still use the previously-loaded config.
 */
export function createPatchConfigHandler(): HttpHandler {
  return async (req, res) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isPlainObject(body)) {
      sendError(res, 400, openaiError("config patch must be a JSON object"));
      return;
    }
    const path = getConfig().paths.userConfigFile;
    // Creates the file on first use and migrates an older one, so the raw
    // tree read next is already at this build's schema version.
    ensureUserConfigFileSync(path);
    let next: UserConfigFile;
    let tree: Record<string, unknown>;
    try {
      tree = readRawConfigTree(path);
      // The version belongs to the file, not to the caller: a patch that
      // raised it would skip migrations, one that lowered it would rerun
      // them over an already-migrated file.
      const { version: _ignored, ...patch } = body;
      mergeConfigPatch(tree, patch, "");
      next = parseUserConfigFile(tree);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    writeRawUserConfigFileSync(path, tree);
    resetConfigCache();
    sendJson(res, 200, { path, config: next });
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge `patch` into `target` in place: plain objects recurse, anything
 * else (arrays, scalars, null) replaces the target's value outright.
 */
function mergeConfigPatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  prefix: string,
): void {
  for (const [key, value] of Object.entries(patch)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (!isSafeConfigPath(key)) {
      throw new ConfigValidationError(dotted, "refusing to write unsafe key");
    }
    if (!isPlainObject(value)) {
      target[key] = value;
      continue;
    }
    // Recurse even into a fresh object, so a nested key is checked by the
    // same guard instead of riding in unexamined with its parent.
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    const child: Record<string, unknown> = isPlainObject(current)
      ? current
      : {};
    target[key] = child;
    mergeConfigPatch(child, value, dotted);
  }
}
