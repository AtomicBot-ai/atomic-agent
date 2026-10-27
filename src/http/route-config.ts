import {
  ConfigValidationError,
  USER_CONFIG_VERSION,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  readUserConfigSnapshotSync,
  readUserConfigVersionOnDiskSync,
  resetConfigCache,
  userConfigFileSha256Sync,
  writeUserConfigFileSync,
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
 *
 * `sha256` is the hash of the bytes `config` was parsed from, from one
 * read (ATO-1022): the same pair `atomic-agent config get --with-sha256`
 * prints, so `PUT /api/config` can compare-and-swap against it.
 */
export function createGetConfigHandler(): HttpHandler {
  return async (_req, res) => {
    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const snapshot = readUserConfigSnapshotSync(path);
    sendJson(res, 200, { path, config: snapshot.config, sha256: snapshot.sha256 });
  };
}

/**
 * `PUT /api/config` — `{ config, expectSha256? }`: replace the whole user
 * config file, as `atomic-agent config set - [--expect-sha256 <hex>]` does
 * (src/cli/config-command.ts `setWholeFile`), without a process per write
 * (ATO-1022: the desktop spawned one for every read and write).
 *
 * Same rules as the CLI: the tree is validated before anything is
 * written, a version newer than both this build and the file is refused,
 * and with `expectSha256` the write happens only while the file still
 * hashes to it — otherwise `409 config_changed` and nothing is written,
 * so the client reads again and re-plans. Like the CLI write, it leaves
 * this process's config cache alone: what the running agent reads
 * changes only where it already did (a restart, a provider reload). The
 * CLI's analytics opt-out report is not sent: it is skipped on the
 * desktop surface, the one client of this route.
 */
export function createPutConfigHandler(): HttpHandler {
  return async (req, res) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isPlainObject(body) || !isPlainObject(body.config)) {
      sendError(res, 400, openaiError("body must be { config: {...}, expectSha256?: string }"));
      return;
    }
    const expected = body.expectSha256;
    if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/i.test(expected))) {
      sendError(res, 400, openaiError("expectSha256 must be a 64-character hex sha256"));
      return;
    }
    const path = getConfig().paths.userConfigFile;
    const version = body.config.version;
    if (typeof version === "number") {
      const accepted = Math.max(
        USER_CONFIG_VERSION,
        readUserConfigVersionOnDiskSync(path) ?? USER_CONFIG_VERSION,
      );
      if (version > accepted) {
        sendError(
          res,
          400,
          openaiError(`version ${version} is newer than this build understands (${accepted})`),
        );
        return;
      }
    }
    let next: UserConfigFile;
    try {
      next = parseUserConfigFile(body.config);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    if (typeof expected === "string" && userConfigFileSha256Sync(path) !== expected.toLowerCase()) {
      sendError(
        res,
        409,
        openaiError("config changed since it was read", "invalid_request_error", null, "config_changed"),
      );
      return;
    }
    writeUserConfigFileSync(path, next);
    sendJson(res, 200, { path, sha256: userConfigFileSha256Sync(path) });
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
