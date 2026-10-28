import { resetConfigCache } from "../config/index.js";

import { openaiError } from "./openai-errors.js";
import { sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/memory/embeddings/reconnect` — reattach memory to the
 * embedding model the config file names now, without a restart (ATO-1024).
 *
 * `atag serve` probes the embedding server once, at boot, so the desktop
 * held the agent's start back until that server answered — up to 20 s on
 * a slow machine. It now starts the agent first and calls this once the
 * embedding server is up. The TUI does the same in-process after a model
 * pick or a daemon restart (`runtime.reconnectMemoryEmbeddings`).
 *
 * The config cache is dropped first: the desktop may have just written
 * `memory.embeddings.enabled` on, and the switch reads the cached config.
 * Answers `{ health, modelId, changed?, why? }`; `501` on a runtime that
 * has no embedding switch.
 */
export function createReconnectMemoryEmbeddingsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const reconnect = ctx.runtime.reconnectMemoryEmbeddings;
    if (!reconnect) {
      sendError(res, 501, openaiError("this runtime cannot reattach memory embeddings", "server_error"));
      return;
    }
    resetConfigCache();
    sendJson(res, 200, await reconnect.call(ctx.runtime));
  };
}
