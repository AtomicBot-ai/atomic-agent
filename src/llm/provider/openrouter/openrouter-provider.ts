import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api";

/** Strips a trailing `/v1` so paths are not doubled (`/api/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeOpenRouterBaseUrl } from "../openai/normalize-openai-base-url.js";

export type OpenRouterProviderOptions = Omit<OpenAiProviderOptions, "baseUrl"> & {
  baseUrl?: string;
  httpReferer?: string;
  xTitle?: string;
};

/**
 * OpenRouter is OpenAI-compatible; this thin wrapper sets default URL
 * and attribution headers required by the service.
 */
export class OpenRouterProvider extends OpenAiProvider {
  constructor(options: OpenRouterProviderOptions) {
    const headers: Record<string, string> = {};
    if (options.httpReferer) {
      headers["HTTP-Referer"] = options.httpReferer;
    }
    if (options.xTitle) {
      headers["X-Title"] = options.xTitle;
    }
    super({
      ...options,
      id: options.id,
      // OpenAiProvider normalizes the base URL.
      baseUrl: options.baseUrl ?? DEFAULT_OPENROUTER_BASE,
      headers: { ...headers, ...options.headers },
      defaultChatModel: options.defaultChatModel ?? "openrouter/auto",
    });
  }
}
