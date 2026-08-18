import { checkLlamaServer } from "../llm/llama-server-health.js";
import { sendJson, type HttpHandler } from "./request-context.js";

/**
 * `GET /health` — liveness probe. Reports the sidecar's own status plus
 * a passthrough summary of the external llama-server reachability.
 *
 * The llama probe is a single attempt on purpose. This route used to
 * inherit `checkLlamaServer`'s full retry ladder (5 attempts with
 * exponential backoff — 15.5 s worst case), which is the one budget a
 * liveness endpoint does not have: orchestrators typically allow 1–10 s
 * before declaring the process dead, so the slow answer read as a hang
 * and restart-looped the sidecar exactly when llama was down. Retrying
 * inside one probe buys nothing anyway — the orchestrator's next poll
 * IS the retry.
 *
 * Status contract:
 * - HTTP 200, `status: "ok"`       — sidecar up, llama reachable.
 * - HTTP 200, `status: "degraded"` — sidecar up, llama down. Still 200
 *   by default: the LLM runtime may legally be absent (indexing,
 *   degraded mode), and restarting the sidecar would not revive llama.
 * - `?strict=1` turns the degraded case into HTTP 503 for orchestrators
 *   that do want restart-on-down semantics.
 */
export function createHealthHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const llama = await checkLlamaServer({ retries: 0 });
    const strict =
      new URL(req.url ?? "/", "http://localhost").searchParams.get("strict") ===
      "1";
    const degraded = !llama.reachable;
    sendJson(res, degraded && strict ? 503 : 200, {
      status: degraded ? "degraded" : "ok",
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
