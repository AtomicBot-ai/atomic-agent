export type ReasoningStyle = "none" | "think-tags" | "channel-tags";

interface BaseModelProfile {
  requiresPromptThinkPrefix: boolean;
  allowThinkPrelude: boolean;
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

  if (looksLikeQwenThinkModel(modelAlias, templateLower, supportsPreserveReasoning)) {
    return QWEN_THINK_PROFILE;
  }
  if (looksLikeGemma4ThinkModel(modelAlias, templateLower)) {
    return GEMMA4_THINK_PROFILE;
  }
  return PLAIN_INSTRUCT_PROFILE;
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
