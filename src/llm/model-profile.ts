export type ReasoningStyle = "none" | "think-tags" | "channel-tags";

interface BaseModelProfile {
  requiresPromptThinkPrefix: boolean;
  allowThinkPrelude: boolean;
  /**
   * Physical context window in tokens, read from `llama-server /props`
   * (`default_generation_settings.n_ctx`, with a root `n_ctx` fallback).
   * Absent when the probe failed or an older llama.cpp build did not
   * expose it — prompt-building then relies purely on configured caps.
   */
  contextWindow?: number;
  /**
   * Multimodal (vision) capability snapshot derived from `/props`.
   *
   * `supported = true` iff llama-server reports an mmproj projector
   * is loaded (one of `has_multimodal`, `multimodal`, or a non-null
   * `mmproj` object at root or under `default_generation_settings`).
   * Older llama.cpp builds that pre-date the multimodal-in-`/props`
   * surface report `supported = false` and `source = "absent"` —
   * callers can fall back to `LocalModelDef.supportsVision` when the
   * server is text-only or the field is missing.
   */
  vision: VisionCapability;
}

export interface VisionCapability {
  supported: boolean;
  /**
   * Which `/props` field signalled the capability. Recorded for
   * observability — the runtime never branches on the source, but
   * trace dumps and the bootstrap log line surface it for debugging.
   */
  source:
    | "modalities.vision"
    | "has_multimodal"
    | "multimodal"
    | "mmproj"
    | "default_generation_settings.has_multimodal"
    | "absent";
}

export interface PlainModelProfile extends BaseModelProfile {
  id: "plain-instruct";
  reasoningStyle: "none";
  reasoningSystemToken?: undefined;
}

export interface TaggedReasoningModelProfile extends BaseModelProfile {
  id: "qwen-think" | "gemma4-think";
  reasoningStyle: "think-tags" | "channel-tags";
  reasoningOpenTag: string;
  reasoningCloseTag: string;
  reasoningSystemToken?: string;
}

export type ModelProfile = PlainModelProfile | TaggedReasoningModelProfile;

/** Default vision snapshot for hand-built profile constants — overwritten by `detectModelProfile`. */
const VISION_ABSENT: VisionCapability = { supported: false, source: "absent" };

export const PLAIN_INSTRUCT_PROFILE: PlainModelProfile = {
  id: "plain-instruct",
  reasoningStyle: "none",
  requiresPromptThinkPrefix: false,
  allowThinkPrelude: false,
  vision: VISION_ABSENT,
};

export const QWEN_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "qwen-think",
  reasoningStyle: "think-tags",
  reasoningOpenTag: "<think>",
  reasoningCloseTag: "</think>",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
  vision: VISION_ABSENT,
};

export const GEMMA4_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "gemma4-think",
  reasoningStyle: "channel-tags",
  reasoningOpenTag: "<|channel>thought\n",
  reasoningCloseTag: "<channel|>",
  reasoningSystemToken: "<|think|>\n",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
  vision: VISION_ABSENT,
};

export function detectModelProfile(props: Record<string, unknown>): ModelProfile {
  const modelAlias = readString(props.model_alias).toLowerCase();
  const chatTemplate = readString(props.chat_template);
  const templateLower = chatTemplate.toLowerCase();
  const caps = readObject(props.chat_template_caps);
  const supportsPreserveReasoning =
    readBoolean(caps.supports_preserve_reasoning) ?? false;

  const base = selectBaseProfile(
    modelAlias,
    templateLower,
    supportsPreserveReasoning,
  );
  const contextWindow = readContextWindow(props);
  const vision = detectVisionSupport(props);
  const enriched = { ...base, vision } as ModelProfile;
  if (contextWindow === null) return enriched;
  return { ...enriched, contextWindow };
}

/**
 * Detect mmproj/multimodal support from a `/props` payload. We check
 * signals in priority order, newest llama.cpp surface first:
 *
 * 1. `modalities.vision: true` — current canonical surface (build
 *    `b1-*` and later). The companion `modalities.audio` flag is
 *    ignored here; vision is the only modality the runtime exposes
 *    via `vision.describe` today.
 * 2. Top-level `has_multimodal: true` — older `mtmd` surface.
 * 3. Top-level `multimodal: true` — fork variant.
 * 4. Non-null `mmproj` object (path / n_embd / etc.) at root or
 *    under `default_generation_settings` — present on builds that
 *    expose the projector blob directly.
 * 5. `default_generation_settings.has_multimodal: true` — legacy
 *    placement of the same flag.
 *
 * Anything else means `supported: false`. The caller (bootstrap)
 * combines this with `config.vision.autoDetect` to decide whether to
 * register the `vision.describe` tool.
 */
export function detectVisionSupport(
  props: Record<string, unknown>,
): VisionCapability {
  const modalities = readObject(props.modalities);
  if (readBoolean(modalities.vision) === true) {
    return { supported: true, source: "modalities.vision" };
  }
  if (readBoolean(props.has_multimodal) === true) {
    return { supported: true, source: "has_multimodal" };
  }
  if (readBoolean(props.multimodal) === true) {
    return { supported: true, source: "multimodal" };
  }
  const mmproj = props.mmproj;
  if (mmproj && typeof mmproj === "object" && !Array.isArray(mmproj)) {
    return { supported: true, source: "mmproj" };
  }
  const defaults = readObject(props.default_generation_settings);
  if (readBoolean(defaults.has_multimodal) === true) {
    return {
      supported: true,
      source: "default_generation_settings.has_multimodal",
    };
  }
  return { supported: false, source: "absent" };
}

function selectBaseProfile(
  modelAlias: string,
  templateLower: string,
  supportsPreserveReasoning: boolean,
): ModelProfile {
  if (looksLikeQwenThinkModel(modelAlias, templateLower, supportsPreserveReasoning)) {
    return QWEN_THINK_PROFILE;
  }
  if (looksLikeGemma4ThinkModel(modelAlias, templateLower)) {
    return GEMMA4_THINK_PROFILE;
  }
  return PLAIN_INSTRUCT_PROFILE;
}

/**
 * Extract the physical context window from a `/props` payload. Current
 * llama.cpp builds nest it under `default_generation_settings.n_ctx`; we
 * also fall back to a root-level `n_ctx` for older builds and custom
 * forks. Returns `null` when neither is a positive number.
 */
function readContextWindow(props: Record<string, unknown>): number | null {
  const defaults = readObject(props.default_generation_settings);
  const nested = toPositiveInt(defaults.n_ctx);
  if (nested !== null) return nested;
  return toPositiveInt(props.n_ctx);
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function looksLikeQwenThinkModel(
  modelAlias: string,
  templateLower: string,
  supportsPreserveReasoning: boolean,
): boolean {
  const aliasHint =
    modelAlias.includes("qwen") ||
    modelAlias.includes("qwq") ||
    modelAlias.includes("deepseek-r1");
  const templateHint =
    templateLower.includes("<think>") &&
    (templateLower.includes("enable_thinking") ||
      templateLower.includes("preserve_thinking") ||
      supportsPreserveReasoning);
  return aliasHint && templateHint;
}

function looksLikeGemma4ThinkModel(modelAlias: string, templateLower: string): boolean {
  const aliasHint = modelAlias.includes("gemma");
  const templateHint =
    templateLower.includes("<|channel>thought") &&
    (templateLower.includes("<|turn>") || templateLower.includes("<turn|>"));
  return aliasHint && templateHint;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
