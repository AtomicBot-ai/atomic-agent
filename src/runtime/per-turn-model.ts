import { SUBSCRIPTION_CLI_KIND } from "../config/provider-auth-mode.js";
import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

/**
 * Why a per-turn model cannot run on `providerId`, or null when it can
 * (ATO-1148). Only a cloud entry takes one: a llama-server link, or an
 * OpenAI-compatible entry pointed at this machine (LM Studio, Ollama),
 * serves the one model the agent loaded for everyone. A Fusion turn may
 * ask a local OpenAI-compatible server for its role's model
 * (`localServer: "allow"`, ATO-1560).
 *
 * Subscription entries (ATO-1592). The turn model reaches them as the
 * variant's `defaultChatModel`:
 * - `subscription-cli` with `cli: "claude"` passes it as `--model`, so
 *   it is honoured.
 * - `subscription-cli` with `cli: "codex"` is refused: under a ChatGPT
 *   login Codex rejects every explicit model id (`-m`, see
 *   codex-cli-adapter.ts), so every such turn would fail. The entry's
 *   own configured model is still accepted, since the operator set it.
 * - `subscription-oauth` sends it as the request's model to the ChatGPT
 *   or Copilot backend; a model the plan does not offer comes back as
 *   that backend's error, as with any cloud entry.
 */
export function perTurnModelRefusal(
  resolved: ResolvedLlmConfig,
  providerId: string,
  model: string,
  options: {
    /**
     * A Fusion turn (ATO-1560): a worker, escalation or judge on an
     * OpenAI-compatible server on this machine (LM Studio, Ollama) asks
     * it for the model the person picked for that role. That server is
     * the Fusion setup's own leg, which loads the model it is asked for,
     * not a model shared by every project. A llama-server link is still
     * refused: it serves the one model it loaded.
     */
    localServer?: "allow";
  } = {},
): string | null {
  if (model.trim().length === 0 || /[\r\n\x00]/.test(model)) {
    return "a per-turn model must be a model id";
  }
  const entry = resolved.providers.find((p) => p.id === providerId);
  if (entry === undefined) return `cannot pin turn to llm provider "${providerId}": not configured`;
  if (entry.kind === "llama-server") {
    return `"${providerId}" is a local model, which is shared by all projects; a per-turn model works on cloud providers only`;
  }
  if (
    entry.kind === SUBSCRIPTION_CLI_KIND &&
    entry.subscriptionCli?.cli === "codex" &&
    model.trim() !== entry.defaultChatModel?.trim()
  ) {
    return `"${providerId}" runs the Codex CLI, which uses the model its ChatGPT login picks; a per-turn model does not work there`;
  }
  if (options.localServer !== "allow" && isLocalServerUrl(entry.baseUrl ?? entry.url)) {
    return `"${providerId}" is a local model, which is shared by all projects; a per-turn model works on cloud providers only`;
  }
  return null;
}
