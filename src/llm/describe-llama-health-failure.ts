import type { HealthResult } from "./llama-server-health.js";
// A leaf predicate with no imports of its own — the one home of the
// loopback host spellings, shared here so the steer text and the
// provider wizard agree on what "local" means.
import { isLocalProviderUrl } from "./provider/presets/is-local-provider-url.js";
import { isLoopbackUrlOnPort } from "../local-llm/server/managed-api-key.js";
import { llamaDefaultPortNote } from "./llama-default-port-note.js";

/**
 * The loopback ports the agent's own engine (Atomic Core) listens on:
 * `localModels.managed.port` and `localModels.embeddings.port`. Callers
 * pass these so the `llama-auth` line can tell our engine from a server
 * the operator started themselves.
 */
export function managedPortsOf(localModels: {
  managed?: { port: number };
  embeddings?: { port: number };
}): number[] {
  return [localModels.managed?.port, localModels.embeddings?.port].filter(
    (port): port is number => typeof port === "number",
  );
}

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
 * True when `url` points at Atomic Chat's Local API Server port. The
 * server 404s `/health` and answers `/v1/models` OpenAI-shape, so it
 * gets the same `openai-compat` verdict Ollama does. Jan, which Atomic
 * Chat forks, uses the same port and the same server contract.
 */
export function looksLikeAtomicChatUrl(url: string): boolean {
  try {
    return new URL(url).port === "1337";
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
  managedPorts: readonly number[] = [],
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
      // Same reasoning as Ollama: the preset row saves its own
      // 127.0.0.1:1337, so name it only for a server on this machine.
      if (looksLikeAtomicChatUrl(url) && isLocalProviderUrl(url)) {
        return (
          `${url} answers like Atomic Chat's Local API Server, not ` +
          `llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › ` +
          `n › Atomic Chat (local), base URL ${url}.`
        );
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
      // UI field for it. A daemon started by atomic-agent (managed mode,
      // `models start`) keeps its key in the models dir (#582), which is
      // where an operator pointing another client at it finds the value.
      // A loopback URL on localModels.managed.port / embeddings.port is
      // the engine the agent runs itself (Atomic Core). Core makes and
      // rotates that key, so the env var and the key file below are the
      // wrong advice. These callers save an External URL, where
      // `models start` refuses ("external mode"), so point at Local
      // models instead and at restarting the app that owns the engine.
      // health.error is left out: it tells the operator to pass --api-key.
      if (isLoopbackUrlOnPort(url, managedPorts)) {
        return (
          `${url} turned down the API key (http 401). This port belongs to ` +
          `the engine Atomic Agent runs itself (Atomic Core), which makes ` +
          `and changes its own key, so setting a key by hand does not help. ` +
          `Choose Local models instead of an External URL for it. If the ` +
          `desktop app runs this engine, restart the app.`
        );
      }
      return (
        `${url}: ${health.error ?? "http 401 — API key required"}. ` +
        `Set ATOMIC_AGENT_LLAMA_API_KEY in the state dir's .env and retry. ` +
        `For a server started by atomic-agent, the key is in ` +
        `<models dir>/llama-server.key.`
      );
    default: {
      const line = `local-llm /health failed at ${url}: ${health.error ?? "unknown"}`;
      // No HTTP answer at all on a default port: the server is most
      // likely on the other one (llama.cpp moved 8080 to 9931).
      const portNote = health.status === null ? llamaDefaultPortNote(url) : null;
      return portNote ? `${line}. ${portNote}` : line;
    }
  }
}
