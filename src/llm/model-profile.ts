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

export const PLAIN_INSTRUCT_PROFILE: PlainModelProfile = {
  id: "plain-instruct",
  reasoningStyle: "none",
  requiresPromptThinkPrefix: false,
  allowThinkPrelude: false,
};

export const QWEN_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "qwen-think",
  reasoningStyle: "think-tags",
  reasoningOpenTag: "<think>",
  reasoningCloseTag: "</think>",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
};

export const GEMMA4_THINK_PROFILE: TaggedReasoningModelProfile = {
  id: "gemma4-think",
  reasoningStyle: "channel-tags",
  reasoningOpenTag: "<|channel>thought\n",
  reasoningCloseTag: "<channel|>",
  reasoningSystemToken: "<|think|>\n",
  requiresPromptThinkPrefix: true,
  allowThinkPrelude: true,
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
  if (contextWindow === null) return base;
  return { ...base, contextWindow };
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
