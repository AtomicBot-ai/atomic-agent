import { isLocalServerUrl } from "../llm/provider/openai/local-server-url.js";
import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";

/**
 * Why a per-turn model cannot run on `providerId`, or null when it can
 * (ATO-1148). Only a cloud entry takes one: a llama-server link, or an
 * OpenAI-compatible entry pointed at this machine (LM Studio, Ollama),
 * serves the one model the agent loaded for everyone.
 */
export function perTurnModelRefusal(
  resolved: ResolvedLlmConfig,
  providerId: string,
  model: string,
): string | null {
  if (model.trim().length === 0 || /[\r\n\x00]/.test(model)) {
    return "a per-turn model must be a model id";
  }
  const entry = resolved.providers.find((p) => p.id === providerId);
  if (entry === undefined) return `cannot pin turn to llm provider "${providerId}": not configured`;
  if (entry.kind === "llama-server" || isLocalServerUrl(entry.baseUrl ?? entry.url)) {
    return `"${providerId}" is a local model, which is shared by all projects; a per-turn model works on cloud providers only`;
  }
  return null;
}
