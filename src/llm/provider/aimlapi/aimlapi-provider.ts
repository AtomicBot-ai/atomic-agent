import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_AIMLAPI_BASE = "https://api.aimlapi.com";

/** Strips a trailing `/v1` so paths are not doubled (`/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeAimlapiBaseUrl } from "../openai/normalize-openai-base-url.js";

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
    super({
      ...options,
      id: options.id,
      // OpenAiProvider normalizes the base URL.
      baseUrl: options.baseUrl ?? DEFAULT_AIMLAPI_BASE,
      defaultChatModel: options.defaultChatModel,
    });
  }
}
