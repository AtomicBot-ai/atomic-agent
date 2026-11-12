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
 *  - Anthropic's newer Claude models (Opus 4.7 and later, Sonnet 5 and
 *    later, Haiku 5 and later, every Fable and Mythos) no longer take
 *    sampling parameters and answer `temperature` with a 400 (ATO-1397).
 *    Older Claude models (Opus 4.6, Sonnet 4.6, Haiku 4.5, …) keep it.
 *  - A model can also be taught its one temperature at run time, from
 *    the 400 that named it (`rememberAllowedTemperature`), or that it
 *    takes none at all, from a 400 that refused the field
 *    (`rememberTemperatureForbidden`).
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
 *  - `fixed`: only this value.
 *
 * `learned` marks a rule taught by a 400 at run time rather than known up
 * front; that one also beats an operator's `extraBody` / `params`, since
 * the service has just said the operator's value is refused.
 */
export type TemperatureRule =
  | { readonly kind: "free" }
  | { readonly kind: "forbidden"; readonly learned?: true }
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

/**
 * A Claude model id in Anthropic's naming: family, major version and an
 * optional minor version (`claude-sonnet-5-5`, `claude-opus-4.8`,
 * `anthropic/claude-fable-5`, Bedrock's `anthropic.claude-haiku-5-5` and
 * `us.anthropic.claude-opus-5-5`). Anchored at the start of the id (after
 * any router prefix, which `modelParamProfile` strips at the last `/`), so
 * a fine-tune that only names Claude (`Qwen3-8B-Claude-Sonnet-5-Distill`)
 * keeps its temperature. The minor is one or two digits so a date suffix
 * (`claude-sonnet-5-20260101`) is not read as one. The old naming
 * (`claude-3-5-sonnet`) does not match and keeps the free rule.
 */
const CLAUDE_MODEL_RE =
  /^(?:[a-z]+\.)?(?:anthropic\.)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?![0-9])/i;

/**
 * Whether a Claude model rejects `temperature`. Anthropic removed the
 * sampling parameters from Opus 4.7 on, from the Sonnet and Haiku 5
 * generations on, and from every Fable and Mythos model; the 5.5 models
 * answer a non-default value with a 400. Unknown future versions fall on
 * the "rejects" side of the line, and the run-time lesson covers a model
 * this rule gets wrong.
 */
function claudeRejectsTemperature(bare: string): boolean {
  const match = CLAUDE_MODEL_RE.exec(bare);
  if (!match) return false;
  const family = match[1]!.toLowerCase();
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  switch (family) {
    case "fable":
    case "mythos":
      return true;
    case "opus":
      return major > 4 || (major === 4 && minor >= 7);
    default:
      // sonnet, haiku
      return major >= 5;
  }
}

const FREE: TemperatureRule = { kind: "free" };

/**
 * Temperatures services told us at run time, keyed by model id: the one
 * value a model accepts, or `forbidden` when it refused the field.
 */
const learnedTemperatures = new Map<string, number | "forbidden">();

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
  if (learned === "forbidden") {
    return {
      temperature: { kind: "forbidden", learned: true },
      capField: "max_tokens",
    };
  }
  if (learned !== undefined) {
    return {
      temperature: { kind: "fixed", value: learned, learned: true },
      capField: "max_tokens",
    };
  }
  if (KIMI_K31_MODEL_RE.test(bare)) {
    return { temperature: { kind: "fixed", value: 1 }, capField: "max_tokens" };
  }
  if (claudeRejectsTemperature(bare)) {
    return { temperature: { kind: "forbidden" }, capField: "max_tokens" };
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

/**
 * Remember, for the rest of the process, that a service refused
 * `temperature` for this model altogether. Returns whether anything
 * changed, like `rememberAllowedTemperature`.
 */
export function rememberTemperatureForbidden(modelId: string): boolean {
  const key = modelId.trim();
  if (learnedTemperatures.get(key) === "forbidden") return false;
  learnedTemperatures.set(key, "forbidden");
  return true;
}

/** Test hook: forget everything learned at run time. */
export function forgetLearnedModelParams(): void {
  learnedTemperatures.clear();
}

/**
 * Claude Fable 5.2 and later (`anthropic/claude-fable-5.2`,
 * `claude-fable-5-2`). The API's own default effort for it is `high`,
 * which on a measured task cost about four times `medium` for the same
 * result; Claude Code and the Claude apps run it at `medium` (ATO-1368).
 */
const FABLE_MEDIUM_DEFAULT_RE =
  /^claude-fable-(?:5[.-](?:[2-9]|[1-9][0-9])|(?:[6-9]|[1-9][0-9]))(?![0-9])/i;

/**
 * The effort to send when the turn asked for none, or `undefined` to
 * leave the service's default. Only for a model whose service default
 * is known to overspend; every other model keeps its own default.
 */
export function defaultReasoningEffort(
  modelId: string,
): "low" | "medium" | "high" | undefined {
  const bare = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return FABLE_MEDIUM_DEFAULT_RE.test(bare) ? "medium" : undefined;
}

/**
 * Gemini models that think and take `reasoning_effort` on Gemini's
 * OpenAI-compatible endpoint: 2.5 and 3.x (`gemini-2.5-flash`,
 * `gemini-2.5-pro`, `gemini-3-pro-preview`, with or without the
 * `models/` prefix). Not 2.0 and older, which do not think, and not the
 * image, speech, live or embedding variants, which are not chat
 * reasoners.
 */
const GEMINI_THINKING_MODEL_RE = /^gemini-(?:2\.5|[3-9])(?![0-9])/i;
const GEMINI_NON_CHAT_VARIANT_RE = /(?:image|tts|audio|live|embedding)/i;
/**
 * 2.5 Flash and Flash-Lite can switch thinking off with
 * `reasoning_effort: "none"`. Flash-Lite does not think by default, so a
 * `low` sent there turns thinking on; Pro and 3.x cannot switch it off.
 */
const GEMINI_FLASH_25_RE = /^gemini-2\.5-flash/i;
/** `gpt-5-chat-latest` and the like: OpenAI ids that are not reasoners. */
const OPENAI_NON_REASONING_VARIANT_RE = /-chat(?![a-z])/i;

function bareModelId(modelId: string): string {
  return modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
}

/**
 * How `reasoningEffort` is spelled for a provider kind. OpenRouter takes a
 * `reasoning` object; OpenAI-compatible services take the flat
 * `reasoning_effort` OpenAI documents; the rest document neither, and a
 * field a service does not know is at best ignored and at worst a 400.
 *
 * Gemini and AI/ML API get the flat field only for models known to take
 * it (`modelId`, ATO-1359): Gemini's thinking models (2.5 and 3.x) on its
 * OpenAI-compatible endpoint, and OpenAI's reasoning models on AI/ML API.
 * Without it a compaction summary on those models thought without bound
 * (Gemini 2.5 thinks dynamically by default), spent the reasoning room
 * and fell back to the crude summary. Other models there keep the body
 * as before, since the field is not documented for them.
 */
export function reasoningEffortField(
  providerKind: string | undefined,
  effort: "low" | "medium" | "high",
  modelId?: string,
  options: { disableThinking?: boolean } = {},
): Record<string, unknown> {
  switch (providerKind) {
    case "openrouter":
      return { reasoning: { effort } };
    case "openai-compatible":
    case "qwen-openai-compatible":
      return { reasoning_effort: effort };
    case "gemini": {
      const bare = modelId ? bareModelId(modelId) : "";
      if (!GEMINI_THINKING_MODEL_RE.test(bare) || GEMINI_NON_CHAT_VARIANT_RE.test(bare)) return {};
      // A call that wants no thinking (the compaction summary) must not
      // turn it on: Flash takes "none", and elsewhere `low` is the floor.
      if (options.disableThinking === true && GEMINI_FLASH_25_RE.test(bare)) {
        return { reasoning_effort: "none" };
      }
      return { reasoning_effort: effort };
    }
    case "aimlapi":
      return modelId &&
        OPENAI_REASONING_MODEL_RE.test(bareModelId(modelId)) &&
        !OPENAI_NON_REASONING_VARIANT_RE.test(bareModelId(modelId))
        ? { reasoning_effort: effort }
        : {};
    default:
      return {};
  }
}
