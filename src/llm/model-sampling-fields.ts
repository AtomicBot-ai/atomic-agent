import type { ModelSamplingDefaults } from "../local-llm/catalog/gguf-sampling.js";
import type { CompletionRequest } from "./provider/completion-types.js";

/**
 * The sampling fields of one llama-server `/completion` payload, in the
 * order of who decides (ATO-2202):
 *
 * 1. the request's own field (a side call pinning `temperature: 0`);
 * 2. the `ATOMIC_AGENT_LLAMA_*` environment override (evals, ops);
 * 3. the loaded model's recommended value from its GGUF header or
 *    `generation_config.json`, only when `useModelSampling` is on;
 * 4. the client's built-in default (0.2 / 0.95 / 40, penalty 1.1 over
 *    the last 256 tokens).
 *
 * `min_p` has no built-in default here: it is sent only when the model
 * names one, so a model that does not keeps llama-server's own.
 */

export interface SamplingEnvOverrides {
  temperature?: number;
  topP?: number;
  topK?: number;
}

export const BUILT_IN_SAMPLING = {
  temperature: 0.2,
  topP: 0.95,
  topK: 40,
  repeatPenalty: 1.1,
  repeatLastN: 256,
} as const;

export function resolveSamplingFields(
  request: Pick<
    CompletionRequest,
    "temperature" | "topP" | "topK" | "repeatPenalty" | "repeatLastN" | "modelSampling"
  >,
  env: SamplingEnvOverrides,
  useModelSampling: boolean,
): Record<string, number> {
  const model: ModelSamplingDefaults =
    useModelSampling && request.modelSampling ? request.modelSampling : {};
  const fields: Record<string, number> = {
    temperature:
      request.temperature ?? env.temperature ?? model.temperature ?? BUILT_IN_SAMPLING.temperature,
    top_p: request.topP ?? env.topP ?? model.topP ?? BUILT_IN_SAMPLING.topP,
    top_k: request.topK ?? env.topK ?? model.topK ?? BUILT_IN_SAMPLING.topK,
    repeat_penalty:
      request.repeatPenalty ?? model.repeatPenalty ?? BUILT_IN_SAMPLING.repeatPenalty,
    repeat_last_n:
      request.repeatLastN ?? model.repeatLastN ?? BUILT_IN_SAMPLING.repeatLastN,
  };
  if (model.minP !== undefined) fields.min_p = model.minP;
  return fields;
}
