import {
  OpenAiProvider,
  type OpenAiProviderOptions,
} from "../openai/openai-provider.js";

export const DEFAULT_GEMINI_BASE = "https://generativelanguage.googleapis.com";
export const GEMINI_API_PATH_PREFIX = "/v1beta/openai";
export const GEMINI_DEFAULT_CHAT_MODEL = "gemini-2.5-flash";

export type GeminiProviderOptions = Omit<
  OpenAiProviderOptions,
  "baseUrl" | "apiPathPrefix" | "defaultChatModel"
> & {
  baseUrl?: string;
  defaultChatModel?: string;
};

/** Gemini's OpenAI-compatible API uses `/v1beta/openai`, not `/v1`. */
export class GeminiProvider extends OpenAiProvider {
  constructor(options: GeminiProviderOptions) {
    super({
      ...options,
      baseUrl: normalizeGeminiBaseUrl(options.baseUrl ?? DEFAULT_GEMINI_BASE),
      apiPathPrefix: GEMINI_API_PATH_PREFIX,
      defaultChatModel: options.defaultChatModel ?? GEMINI_DEFAULT_CHAT_MODEL,
    });
  }
}

function normalizeGeminiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith(GEMINI_API_PATH_PREFIX)
    ? trimmed.slice(0, -GEMINI_API_PATH_PREFIX.length)
    : trimmed;
}
