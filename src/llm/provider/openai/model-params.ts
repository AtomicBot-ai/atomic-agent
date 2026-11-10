/**
 * Per-model-family wire parameters for OpenAI-compatible chat bodies.
 *
 * Facts the builders need about a model id, kept next to each other so
 * the rule that reads the id lives in one place:
 *
 *  - OpenAI's reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`, `gpt-6`, …) reject
 *    `temperature` and reject `max_tokens` in favour of
 *    `max_completion_tokens`. atag's own `request-size-rejection.ts`
 *    quotes the second rejection verbatim and used to rely on the
 *    fallback chain to survive it; the first simply failed the turn.
 *  - Moonshot's Kimi K3.1 family accepts exactly one temperature, 1, and
 *    answers anything else with a 400 ("only 1 is allowed for this
 *    model"). Kimi K2.x takes any value and keeps the historical body.
 *  - A model can also be taught its one temperature at run time, from
 *    the 400 that named it (`rememberAllowedTemperature`).
 *  - Everything else keeps the historical body byte for byte.
 *
 * The id is read after any vendor prefix (`openai/o3` on OpenRouter is
 * the same model as `o3` on OpenAI), and the prefix test is anchored so
 * a name that merely starts with the letter `o` (`olmo`) is not a
 * reasoning model.
 */

/**
 * What a model accepts as `temperature`:
 *  - `free`: any value; the caller's, else its default.
 *  - `forbidden`: the field must not be sent at all.
 *  - `fixed`: only this value. `learned` marks one taught by a 400 at
 *    run time rather than known up front; that one also beats an
 *    operator's `extraBody` / `params`, since the service has just said
 *    the operator's value is refused.
 */
export type TemperatureRule =
  | { readonly kind: "free" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "fixed"; readonly value: number; readonly learned?: true };

export interface ModelParamProfile {
  /** What the model accepts as `temperature`. */
  temperature: TemperatureRule;
  /** The field the output cap is spelled in. */
  capField: "max_tokens" | "max_completion_tokens";
}

/**
 * `o1`…`o9` and every GPT generation from 5 on (`gpt-5.4-mini`,
 * `gpt-6.2-sol`, `openai/gpt-6-terra`, ATO-1339). GPT-4.x and older take
 * `temperature` and `max_tokens` and keep the historical body, and so
 * does Azure's `gpt-35-turbo`: the generation is one digit, never two.
 */
const OPENAI_REASONING_MODEL_RE = /^(?:o[1-9](?![a-z])|gpt-[5-9](?![0-9a-z]))/i;

/**
 * `kimi-k3.1`, `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed`, with or
 * without a vendor prefix (`moonshotai/kimi-k3.1-pro`). Not `kimi-k2.x`,
 * which takes any temperature, and deliberately not plain `kimi-k3`:
 * whether K3 (without `.1`) has the same restriction is unverified, so
 * it keeps the free rule until a real rejection says otherwise (and if
 * one does, the run-time lesson below covers it).
 */
const KIMI_K31_MODEL_RE = /^kimi-k3\.1(?![0-9])/i;

const FREE: TemperatureRule = { kind: "free" };

/** Temperatures services told us at run time, keyed by model id. */
const learnedTemperatures = new Map<string, number>();

export function modelParamProfile(modelId: string): ModelParamProfile {
  const bare = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  if (OPENAI_REASONING_MODEL_RE.test(bare)) {
    return {
      temperature: { kind: "forbidden" },
      capField: "max_completion_tokens",
    };
  }
  const learned = learnedTemperatures.get(modelId.trim());
  if (learned !== undefined) {
    return {
      temperature: { kind: "fixed", value: learned, learned: true },
      capField: "max_tokens",
    };
  }
  if (KIMI_K31_MODEL_RE.test(bare)) {
    return { temperature: { kind: "fixed", value: 1 }, capField: "max_tokens" };
  }
  return { temperature: FREE, capField: "max_tokens" };
}

/**
 * The temperature to put on the wire, or `undefined` for none: the
 * caller's value (else `fallback`) when the model is free, nothing when
 * it is forbidden, the one allowed value when it is fixed.
 */
export function resolveTemperature(
  profile: ModelParamProfile,
  requested: number | undefined,
  fallback: number | undefined,
): number | undefined {
  switch (profile.temperature.kind) {
    case "forbidden":
      return undefined;
    case "fixed":
      return profile.temperature.value;
    case "free":
      return requested ?? fallback;
  }
}

/**
 * Remember, for the rest of the process, the one temperature a service
 * said this model accepts. Returns whether anything changed, so a caller
 * retrying on the lesson can tell a new one from a repeat.
 */
export function rememberAllowedTemperature(
  modelId: string,
  value: number,
): boolean {
  const key = modelId.trim();
  if (learnedTemperatures.get(key) === value) return false;
  learnedTemperatures.set(key, value);
  return true;
}

/** Test hook: forget everything learned at run time. */
export function forgetLearnedModelParams(): void {
  learnedTemperatures.clear();
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
