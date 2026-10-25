import { getConfig } from "../config/index.js";
import { managedPortsOf } from "../llm/describe-llama-health-failure.js";
import { recheckLocalConnection } from "../llm/recheck-local-connection.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/local-model/recheck` — the desktop's Reconnect button
 * (ATO-873, variant B). Checks `localModels.url` again the way saving it
 * does and answers the verdict:
 *
 *   `{ url, verdict, ok, message, portHint }`
 *
 * `verdict` is one of `ok`, `loading`, `ollama`, `atomic_chat`,
 * `openai_compat`, `key_rejected`, `not_model_server`, `unreachable`;
 * `message` is the plain sentence to show; `portHint` names 9931 for an
 * address on llama.cpp's old 8080 default (or the other default port
 * when nothing answered), null otherwise.
 *
 * Takes no body: it checks only the address the agent itself uses, read
 * live so an address the desktop just saved is the one checked. Writes
 * nothing. Behind the API key like every `/api` route, because it makes
 * the agent send a request.
 */
export function createLocalModelRecheckHandler(
  recheck: typeof recheckLocalConnection = recheckLocalConnection,
): HttpHandler {
  return async (_req, res) => {
    const { localModels } = getConfig();
    const result = await recheck({
      url: localModels.url,
      managedPorts: managedPortsOf(localModels),
    });
    sendJson(res, 200, result);
  };
}
