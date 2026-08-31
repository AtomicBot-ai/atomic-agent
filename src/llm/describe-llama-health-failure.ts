import type { HealthResult } from "./llama-server-health.js";
// A leaf predicate with no imports of its own — the one home of the
// loopback host spellings, shared here so the steer text and the
// provider wizard agree on what "local" means.
import { isLocalProviderUrl } from "../tui/providers/is-local-provider-url.js";

/**
 * True when `url` points at Ollama's default port. Ollama is the server
 * operators point the External llama.cpp URL at most often (verified:
 * `ollama serve` answers 404 on `/health` and OpenAI-shape on
 * `/v1/models`, so the probe reports `openai-compat`), and the port is
 * the one signal the probe already has without another round trip.
 */
export function looksLikeOllamaUrl(url: string): boolean {
  try {
    return new URL(url).port === "11434";
  } catch {
    return false;
  }
}

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
      // vLLM speak /v1/* but not llama.cpp's native endpoints. Port
      // 11434 is named as Ollama outright — that is the server this
      // verdict almost always is, and "openai-compatible" alone did not
      // tell an Ollama user the message was about them.
      if (looksLikeOllamaUrl(url)) {
        // The "Ollama (local)" preset row shows no base-URL screen — it
        // saves its own localhost:11434 — so pointing at it is only
        // followable when that is the server probed here. A remote
        // Ollama goes through the manual compat row instead, which asks
        // for the URL and so keeps the host.
        return isLocalProviderUrl(url)
          ? `${url} answers like Ollama (its default port), not llama.cpp. ` +
              `Add it as a cloud provider instead: LLM tab › Cloud › n › ` +
              `Ollama (local), base URL ${url}.`
          : `${url} answers like Ollama (its default port), not llama.cpp. ` +
              `Add it as a cloud provider instead: LLM tab › Cloud › n › ` +
              `openai-compatible, base URL ${url} (any API key value ` +
              `passes — a stock Ollama has no auth).`;
      }
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
