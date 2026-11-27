import type { LlmFailureContext } from "../../error-reporting/index.js";
import { isOllamaEntry } from "../../llm/provider/ollama/ollama-context-window.js";
import type { ResolvedLlmConfig } from "../../llm/provider/index.js";

/** How far down `cause` the facts are looked for. */
const MAX_CAUSE_DEPTH = 4;

/**
 * The completion facts of a `ModelError` (`ModelError.completion`) on
 * the error or its causes (ATO-2421): the turn-level wrapper of a second
 * empty reply keeps the first as its cause. Only the fixed fields are
 * copied, never anything else on the error.
 */
export function readCompletionFacts(
  error: unknown,
): LlmFailureContext["completionFacts"] {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const facts = (current as { completion?: unknown }).completion;
    if (typeof facts === "object" && facts !== null) {
      const raw = facts as Record<string, unknown>;
      if (typeof raw.reasoningPresent === "boolean") {
        return {
          finishReason: typeof raw.finishReason === "string" ? raw.finishReason : null,
          ...(typeof raw.stopType === "string" ? { stopType: raw.stopType } : {}),
          reasoningPresent: raw.reasoningPresent,
          promptTokens: typeof raw.promptTokens === "number" ? raw.promptTokens : 0,
          completionTokens: typeof raw.completionTokens === "number" ? raw.completionTokens : 0,
        };
      }
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Which kind of server the link `providerId` points at: a local Ollama
 * (`isOllamaEntry`), a llama-server link (ours or the person's, and the
 * synthesized local entry no config lists), or anything else.
 */
export function serverKindOf(
  llm: ResolvedLlmConfig,
  providerId: string,
): "ollama" | "llama_server" | "other" {
  const entry = llm.providers.find((p) => p.id === providerId);
  if (entry === undefined) return "llama_server";
  if (isOllamaEntry(entry)) return "ollama";
  return entry.kind === "llama-server" ? "llama_server" : "other";
}
