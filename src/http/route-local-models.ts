import { runLocalModelsList, runLocalModelsStatus } from "../cli/models-handlers.js";

import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /api/local-models/list` and `/api/local-models/status` — the text
 * `atomic-agent models list` / `models status` print, for the computer this
 * agent runs on (ATO-1127). The desktop connected to an agent on another
 * computer shows these in Settings › Models instead of its own machine's,
 * and parses them exactly as it parses the CLI's output. Reads only.
 */
export function createLocalModelsTextHandler(view: "list" | "status"): HttpHandler {
  return async (_req, res) => {
    let text = "";
    const write = (chunk: string): void => {
      text += chunk;
    };
    const code = view === "list" ? await runLocalModelsList(write) : await runLocalModelsStatus(write);
    sendJson(res, 200, { ok: code === 0, text });
  };
}
