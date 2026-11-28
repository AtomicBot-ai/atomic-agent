import type { ModelSamplingDefaults } from "../local-llm/catalog/gguf-sampling.js";
import { layerSampling } from "../local-llm/catalog/model-sampling-sets.js";
import type { CompletionRequest } from "./provider/completion-types.js";

/**
 * The sampling fields of one llama-server `/completion` payload, in the
 * order of who decides (ATO-2202):
 *
 * 1. the request's own field (a side call pinning `temperature: 0`);
 * 2. the `ATOMIC_AGENT_LLAMA_*` environment override (evals, ops);
 * 3. the person's own set for this model (`request.userSampling`,
 *    ATO-2482), whether `useModelSampling` is on or not;
 * 4. the loaded model's recommended value from its catalog entry, GGUF
 *    header or `generation_config.json`, only when `useModelSampling` is on;
 * 5. the client's built-in default (0.2 / 0.95 / 40, penalty 1.1 over
 *    the last 256 tokens).
 *
 * `min_p` and `presence_penalty` have no built-in default here: each is
 * sent only when a set names it, so otherwise llama-server keeps its own.
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
    | "temperature"
    | "topP"
    | "topK"
    | "repeatPenalty"
    | "repeatLastN"
    | "modelSampling"
    | "userSampling"
  >,
  env: SamplingEnvOverrides,
  useModelSampling: boolean,
): Record<string, number> {
  const fromModel: ModelSamplingDefaults =
    useModelSampling && request.modelSampling ? request.modelSampling : {};
  // The person's set wins field by field over the model's own.
  const model = layerSampling(request.userSampling ?? {}, fromModel);
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
  if (model.presencePenalty !== undefined) {
    fields.presence_penalty = model.presencePenalty;
  }
  return fields;
}
