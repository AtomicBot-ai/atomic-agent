import { runLocalModelsList, runLocalModelsListEmbeddings, runLocalModelsStatus } from "../cli/models-handlers.js";
import { withFreshConfig } from "../config/index.js";

import { sendJson, type HttpHandler } from "./request-context.js";

export type LocalModelsTextView = "list" | "status" | "list-embeddings";

/**
 * `GET /api/local-models/list`, `/status` and `/list-embeddings` — the text
 * `atomic-agent models list` / `models status` / `models list-embeddings`
 * print, for the computer this agent runs on (ATO-1127). The desktop
 * connected to an agent on another computer shows these in Settings ›
 * Models instead of its own machine's, and parses them exactly as it parses
 * the CLI's output. Reads only.
 *
 * ATO-1213: read from the config file as it is now, not the one serve
 * booted with (`withFreshConfig`), so a model switched with `atag models
 * use` on that computer shows as the active one at once; and the embedding
 * models are listed too.
 */
export function createLocalModelsTextHandler(view: LocalModelsTextView): HttpHandler {
  return async (_req, res) => {
    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    const code = await withFreshConfig(() =>
      view === "list"
        ? runLocalModelsList(write)
        : view === "status"
          ? runLocalModelsStatus(write)
          : runLocalModelsListEmbeddings(write),
    );
    sendJson(res, 200, { ok: code === 0, text });
  };
}
