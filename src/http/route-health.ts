import { checkLlamaServer } from "../llm/llama-server-health.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /health` — liveness probe. Reports the sidecar's own status plus
 * a passthrough summary of the external llama-server reachability. We
 * intentionally return 200 even when llama is down so orchestrators
 * can tell the sidecar apart from the LLM runtime (which may legally
 * be absent during indexing/degraded mode).
 */
export function createHealthHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const llama = await checkLlamaServer();
    sendJson(res, 200, {
      status: "ok",
      runtime: "atomic-agent",
      workingDir: ctx.runtime.capabilities.workingDir,
      llama: {
        url: ctx.runtime.config.localModels.url,
        reachable: llama.reachable,
        latencyMs: llama.latencyMs,
        error: llama.error,
      },
    });
  };
}
