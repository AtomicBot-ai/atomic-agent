/**
 * Per-model-family wire parameters for OpenAI-compatible chat bodies.
 *
 * Two facts the builder needs about a model id, kept next to each other
 * so the rule that reads the id lives in one place:
 *
 *  - OpenAI's reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`, …) reject
 *    `temperature` and reject `max_tokens` in favour of
 *    `max_completion_tokens`. atag's own `request-size-rejection.ts`
 *    quotes the second rejection verbatim and used to rely on the
 *    fallback chain to survive it; the first simply failed the turn.
 *  - Everything else keeps the historical body byte for byte.
 *
 * The id is read after any vendor prefix (`openai/o3` on OpenRouter is
 * the same model as `o3` on OpenAI), and the prefix test is anchored so
 * a name that merely starts with the letter `o` (`olmo`) is not a
 * reasoning model.
 */
export interface ModelParamProfile {
  /** Whether the model accepts `temperature` at all. */
  temperature: boolean;
  /** The field the output cap is spelled in. */
  capField: "max_tokens" | "max_completion_tokens";
}

const OPENAI_REASONING_MODEL_RE = /^(?:o[1-9]|gpt-5)(?![a-z])/i;

export function modelParamProfile(modelId: string): ModelParamProfile {
  const bare = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  if (OPENAI_REASONING_MODEL_RE.test(bare)) {
    return { temperature: false, capField: "max_completion_tokens" };
  }
  return { temperature: true, capField: "max_tokens" };
}

/**
 * How `reasoningEffort` is spelled for a provider kind. OpenRouter takes a
 * `reasoning` object; OpenAI-compatible services take the flat
 * `reasoning_effort` OpenAI documents; the rest document neither, and a
 * field a service does not know is at best ignored and at worst a 400.
 */
export function reasoningEffortField(
  providerKind: string | undefined,
  effort: "low" | "medium" | "high",
): Record<string, unknown> {
  switch (providerKind) {
    case "openrouter":
      return { reasoning: { effort } };
    case "openai-compatible":
    case "qwen-openai-compatible":
      return { reasoning_effort: effort };
    default:
      return {};
  }
}
