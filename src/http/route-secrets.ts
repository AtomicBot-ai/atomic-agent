import {
  SecretAccessError,
  applySavedSecretToEnvAsync,
  getConfig,
  listSavedSecretRefs,
  readSecretsStoreState,
  saveSecret,
  secretRefSource,
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
 * - `GET /api/secrets` answers `{ store, keychainKeys, references }`: where
 *   keys are saved, the NAMES held in the keychain and, for each key saved
 *   as a reference (ATO-2339), where it comes from (`references[name]`:
 *   `1password`, `bitwarden`, `vault` or `command`, ATO-2530). Never values.
 * - `PUT /api/secrets/{name}` with `{ value: string | null }` saves (or
 *   removes) one key through the agent's own writer, wherever keys live
 *   now, and puts it in this process's environment at once, as the
 *   terminal's provider wizard does, so the running agent uses the new key
 *   without a restart. A reference is resolved first (ATO-2530): the
 *   environment gets its value, never `op://…`. Answers `{ name, store }`,
 *   plus `reference: { source, resolved, error? }` for a reference; a
 *   failed one is still saved and `error` says why it could not be read.
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
    const stateDir = getConfig().paths.stateDir;
    const state = readSecretsStoreState(stateDir);
    const references: Record<string, string> = {};
    for (const entry of listSavedSecretRefs(stateDir)) references[entry.name] = entry.source;
    sendJson(res, 200, { store: state.store, keychainKeys: state.keychainKeys, references });
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
      const stateDir = getConfig().paths.stateDir;
      const saved = saveSecret(stateDir, name, trimmed);
      const applied = await applySavedSecretToEnvAsync(stateDir, name, trimmed, { env });
      const source = trimmed === null ? null : secretRefSource(trimmed);
      sendJson(res, 200, {
        name,
        store: saved.store,
        ...(source === null
          ? {}
          : { reference: { source, resolved: applied.resolved, ...(applied.error ? { error: applied.error } : {}) } }),
      });
    } catch (err) {
      if (err instanceof SecretAccessError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
  };
}
