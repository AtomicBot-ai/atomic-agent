import type { ResolvedLlmConfig } from "../llm/provider/registry/provider-types.js";
import { perTurnModelRefusal } from "../runtime/per-turn-model.js";

/** What `run --model` hands `runtime.runTurn` for every turn (ATO-2307). */
export interface RunModelPin {
  providerId: string;
  model?: string;
}

/**
 * Turn the `--model` value into a provider pin. A configured provider id
 * pins that provider with its own model; `<provider>:<model>` (split at
 * the first colon, only when the head is a configured provider) pins
 * both; anything else is a model id on the active provider, so an
 * Ollama-style `qwen3:8b` stays one model id. A per-turn model on a
 * local provider is refused here, before anything boots, with the same
 * words the runtime would use.
 */
export function resolveRunModel(
  value: string,
  llm: Pick<ResolvedLlmConfig, "activeTextProvider" | "providers">,
): RunModelPin | { error: string } {
  const wanted = value.trim();
  if (wanted.length === 0) {
    return { error: "--model needs a model id or <provider>:<model>" };
  }
  const ids = new Set(llm.providers.map((p) => p.id));
  let pin: RunModelPin = { providerId: llm.activeTextProvider, model: wanted };
  if (ids.has(wanted)) {
    pin = { providerId: wanted };
  } else {
    const colon = wanted.indexOf(":");
    const head = colon > 0 ? wanted.slice(0, colon) : "";
    if (ids.has(head)) {
      const model = wanted.slice(colon + 1).trim();
      pin = model.length > 0 ? { providerId: head, model } : { providerId: head };
    }
  }
  if (pin.model !== undefined) {
    const refusal = perTurnModelRefusal(
      llm as ResolvedLlmConfig,
      pin.providerId,
      pin.model,
    );
    if (refusal !== null) return { error: `--model: ${refusal}` };
  }
  return pin;
}
