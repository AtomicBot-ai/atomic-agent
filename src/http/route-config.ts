import { getConfigFile, patchConfigFile } from "../runtime-api/index.js";
import type { UserConfigFile } from "../config/index.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { sendRuntimeApiError } from "./runtime-api-http.js";

/**
 * `GET /api/config` — return the current user config file contents,
 * creating a default file on first read if one does not yet exist.
 */
export function createGetConfigHandler(): HttpHandler {
  return async (_req, res) => {
    const { path, config } = getConfigFile();
    sendJson(res, 200, { path, config });
  };
}

/**
 * `PATCH /api/config` — shallow-merge the request body into the user
 * config file and persist atomically via the shared runtime-facade.
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
    try {
      const { path, config } = patchConfigFile(body);
      sendJson(res, 200, { path, config });
    } catch (err) {
      if (sendRuntimeApiError(res, err)) return;
      throw err;
    }
  };
}
