import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api";

/** Strips a trailing `/v1` so paths are not doubled (`/api/v1/v1/...`). */
export function normalizeOpenRouterBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

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
    const baseUrl = normalizeOpenRouterBaseUrl(
      options.baseUrl ?? DEFAULT_OPENROUTER_BASE,
    );
    super({
      ...options,
      id: options.id,
      baseUrl,
      headers: { ...headers, ...options.headers },
      defaultChatModel: options.defaultChatModel ?? "openrouter/auto",
    });
  }
}
