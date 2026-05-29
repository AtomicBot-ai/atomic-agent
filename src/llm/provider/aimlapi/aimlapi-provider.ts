import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_AIMLAPI_BASE = "https://api.aimlapi.com";

/** Strips a trailing `/v1` so paths are not doubled (`/v1/v1/...`). */
export function normalizeAimlapiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -"/v1".length);
  }
  return trimmed;
}

export type AimlapiProviderOptions = Omit<OpenAiProviderOptions, "baseUrl"> & {
  baseUrl?: string;
};

/**
 * AI/ML API (aimlapi.com) is OpenAI-compatible; this thin wrapper sets
 * the default base URL. Unlike OpenRouter, no attribution headers are
 * required by the service.
 */
export class AimlapiProvider extends OpenAiProvider {
  constructor(options: AimlapiProviderOptions) {
    const baseUrl = normalizeAimlapiBaseUrl(
      options.baseUrl ?? DEFAULT_AIMLAPI_BASE,
    );
    super({
      ...options,
      id: options.id,
      baseUrl,
      defaultChatModel: options.defaultChatModel,
    });
  }
}
