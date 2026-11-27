import { getConfig } from "../config/index.js";
import { lanUrls } from "../cli/serve-args.js";
import { ensureModelShareKey, rotateModelShareKey } from "./model-share-key.js";
import type { ModelShareListener, ShareListenerState } from "./model-share-listener.js";
import {
  isModelShareMode,
  readModelShareSettings,
  writeModelShareMode,
  type ModelShareMode,
} from "./model-share-settings.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";
import { RAW_MODEL_PREFIX } from "./route-raw-model.js";

/**
 * ATO-2483: `GET /api/model-share` and `POST /api/model-share`, what the
 * desktop's Settings › Models "Share this model" card reads and sets.
 * Admin scope (http-scopes.ts): the answer carries the share key.
 *
 * GET answers `{ mode, port, key, urls: { local, lan }, listener }`:
 * `mode` off / local / network (model-share-settings.ts), the key while
 * sharing is on (`null` while off), the base URLs another app pastes
 * (`lan` only when other devices can reach it) and where the share
 * listener is now (model-share-listener.ts; `null` in a host without one).
 *
 * POST takes `{ mode, rotate? }`: writes the mode to the config file, makes
 * the key on first use (`rotate: true` replaces it, cutting off every app
 * that held the old one), opens, moves or closes the listener, and answers
 * the same shape. The key is never logged.
 */

export interface ModelShareRouteDeps {
  listener: ModelShareListener | null;
  /** Tests pass fixed addresses; default: this computer's IPv4 interfaces. */
  lanOrigins?: (port: number) => string[];
}

export interface ModelShareAnswer {
  mode: ModelShareMode;
  port: number;
  key: string | null;
  urls: { local: string; lan: string[] };
  listener: ShareListenerState | null;
}

function answerOf(mode: ModelShareMode, port: number, key: string | null, listener: ShareListenerState | null, lanOrigins: (port: number) => string[]): ModelShareAnswer {
  const livePort = listener?.state === "listening" || listener?.state === "main" ? listener.port : port;
  const reachable =
    listener === null
      ? mode === "network"
      : listener.state === "listening"
        ? listener.host === "0.0.0.0"
        : listener.state === "main" && listener.network;
  return {
    mode,
    port: livePort,
    key: mode === "off" ? null : key,
    urls: {
      local: `http://127.0.0.1:${livePort}${RAW_MODEL_PREFIX}`,
      lan: mode !== "off" && reachable ? lanOrigins(livePort).map((origin) => `${origin}${RAW_MODEL_PREFIX}`) : [],
    },
    listener,
  };
}

const defaultLanOrigins = (port: number): string[] => lanUrls("0.0.0.0", port);

export function createModelShareHandlers(deps: ModelShareRouteDeps): { get: HttpHandler; set: HttpHandler } {
  const lanOrigins = deps.lanOrigins ?? defaultLanOrigins;

  const get: HttpHandler = async (_req, res) => {
    const settings = readModelShareSettings();
    const key = settings.mode === "off" ? null : ensureModelShareKey(getConfig().paths.stateDir);
    sendJson(res, 200, answerOf(settings.mode, settings.port, key, deps.listener?.current() ?? null, lanOrigins));
  };

  const set: HttpHandler = async (req, res) => {
    let body: { mode?: unknown; rotate?: unknown };
    try {
      body = await readJsonBody<{ mode?: unknown; rotate?: unknown }>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isModelShareMode(body.mode)) {
      sendError(res, 400, openaiError("mode must be one of off, local, network", "invalid_request_error", "mode"));
      return;
    }
    if (body.rotate !== undefined && typeof body.rotate !== "boolean") {
      sendError(res, 400, openaiError("rotate must be a boolean", "invalid_request_error", "rotate"));
      return;
    }
    const mode = body.mode;
    const config = getConfig();
    let key: string | null = null;
    if (mode !== "off") {
      key = body.rotate === true ? rotateModelShareKey(config.paths.stateDir) : ensureModelShareKey(config.paths.stateDir);
      if (key === null) {
        sendError(res, 500, openaiError("The share key could not be saved, so sharing stayed as it was", "server_error", null, "share_key_unwritable"));
        return;
      }
    }
    try {
      writeModelShareMode(config.paths.userConfigFile, mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, openaiError(`could not save the sharing setting: ${message}`, "server_error"));
      return;
    }
    const settings = readModelShareSettings(config.paths.userConfigFile);
    const listener = deps.listener ? await deps.listener.apply(settings) : null;
    sendJson(res, 200, answerOf(settings.mode, settings.port, key, listener, lanOrigins));
  };

  return { get, set };
}
