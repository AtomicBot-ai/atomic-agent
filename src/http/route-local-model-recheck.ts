import { loadConfig } from "../config/index.js";
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
 * Takes no body and never a client URL: it checks only the address in
 * the config file. The file is read fresh on every call (`loadConfig`,
 * not the process's cached `getConfig`), so an address the desktop just
 * saved with `atomic-agent config set` is the one checked; the cache is
 * left alone. Writes nothing. Behind the API key like every `/api`
 * route, because it makes the agent send a request.
 */
export function createLocalModelRecheckHandler(
  recheck: typeof recheckLocalConnection = recheckLocalConnection,
): HttpHandler {
  return async (_req, res) => {
    const { localModels } = loadConfig();
    const result = await recheck({
      url: localModels.url,
      managedPorts: managedPortsOf(localModels),
    });
    sendJson(res, 200, result);
  };
}
