import {
  SecretAccessError,
  getConfig,
  readSecretsStoreState,
  saveSecret,
} from "../config/index.js";

import { openaiError } from "./openai-errors.js";
import type { IncomingMessage } from "node:http";

import { isLocalRequest } from "./auth-throttle.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * Saved API keys and tokens through the running agent (ATO-1639), for the
 * desktop app: it used to write `<stateDir>/.env` itself, so with the
 * opt-in OS keychain (ATO-474) its keys stayed in plaintext and the keys
 * the terminal kept in the keychain looked missing to it.
 *
 * - `GET /api/secrets` answers `{ store, keychainKeys }`: where keys are
 *   saved and the NAMES held in the keychain. Never values.
 * - `PUT /api/secrets/{name}` with `{ value: string | null }` saves (or
 *   removes) one key through the agent's own writer, wherever keys live
 *   now, and puts it in this process's environment at once, as the
 *   terminal's provider wizard does, so the running agent uses the new key
 *   without a restart. Answers `{ name, store }`.
 *
 * There is no route that reads a value back. Only secret-shaped names
 * (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`) are accepted, so this
 * cannot set `PATH` or `NODE_OPTIONS` for the next start, and only a
 * caller on this machine is served: keys belong to the machine they are
 * saved on, not to a client on the network (nor through the
 * `atag pair --remote` tunnel, ATO-2308: isLocalRequest).
 */

function refuseRemote(req: IncomingMessage, res: Parameters<HttpHandler>[1]): boolean {
  if (isLocalRequest(req)) return false;
  sendError(
    res,
    403,
    openaiError("saved keys can only be managed on this computer", "invalid_request_error", null, "loopback_only"),
  );
  return true;
}

export function createGetSecretsHandler(): HttpHandler {
  return async (req, res) => {
    if (refuseRemote(req, res)) return;
    const state = readSecretsStoreState(getConfig().paths.stateDir);
    sendJson(res, 200, { store: state.store, keychainKeys: state.keychainKeys });
  };
}

export function createPutSecretHandler(
  env: NodeJS.ProcessEnv = process.env,
): HttpHandler {
  return async (req, res, ctx) => {
    if (refuseRemote(req, res)) return;
    const name = ctx.params.name ?? "";
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    const value =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { value?: unknown }).value
        : undefined;
    if (value !== null && typeof value !== "string") {
      sendError(res, 400, openaiError("body must be { value: string | null }"));
      return;
    }
    const trimmed = value === null ? null : value.trim();
    try {
      const saved = saveSecret(getConfig().paths.stateDir, name, trimmed);
      if (trimmed === null) delete env[name];
      else env[name] = trimmed;
      sendJson(res, 200, { name, store: saved.store });
    } catch (err) {
      if (err instanceof SecretAccessError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
  };
}
