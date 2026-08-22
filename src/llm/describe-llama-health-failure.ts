import type { HealthResult } from "./llama-server-health.js";

/**
 * One operator-actionable line per probe verdict, shared by every
 * surface that saves an external llama.cpp URL (LLM tab External pane,
 * first-run wizard). Stub-verified failure shapes each map to what the
 * operator must actually do — a bare "http 404" or "fetch failed" told
 * them nothing at the exact moment they were ready to act.
 */
export function describeLlamaHealthFailure(
  health: HealthResult,
  url: string,
): string {
  switch (health.kind) {
    case "openai-compat":
      // A real server, wrong route: KoboldCpp / LM Studio / Ollama /
      // vLLM speak /v1/* but not llama.cpp's native endpoints.
      return (
        `${url} answers like an OpenAI-compatible server, not llama.cpp. ` +
        `Add it as a cloud provider instead: LLM tab › Cloud › n › ` +
        `openai-compatible, base URL ${url}.`
      );
    case "llama-loading":
      return (
        `${url} is a llama.cpp server still loading its model. ` +
        `Give it a minute and save the URL again.`
      );
    case "llama-auth":
      // /health is exempt from --api-key, so this is the first moment
      // the key problem is even visible. Name the env var: there is no
      // UI field for it.
      return (
        `${url}: ${health.error ?? "http 401 — API key required"}. ` +
        `Set ATOMIC_AGENT_LLAMA_API_KEY in the state dir's .env and retry.`
      );
    default:
      return `local-llm /health failed at ${url}: ${health.error ?? "unknown"}`;
  }
}
