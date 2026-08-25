import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_AIMLAPI_BASE = "https://api.aimlapi.com";

/** Strips a trailing `/v1` so paths are not doubled (`/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeAimlapiBaseUrl } from "../openai/normalize-openai-base-url.js";

const DEFAULT_AIMLAPI_PARTNER_ID = "part_IYG5D7rgbiI7fw78UtwBzxkm";

function buildAimlapiAttributionHeaders(): Record<string, string> {
  const partnerId = process.env.AIMLAPI_PARTNER_ID?.trim() || DEFAULT_AIMLAPI_PARTNER_ID;
  return {
    "X-AIMLAPI-Source": "agent/atomic-agent",
    "X-AIMLAPI-Partner-ID": partnerId,
  };
}

export type AimlapiProviderOptions = Omit<OpenAiProviderOptions, "baseUrl"> & {
  baseUrl?: string;
};

/**
 * AI/ML API (aimlapi.com) is OpenAI-compatible; this thin wrapper sets
 * the default base URL and attaches partner attribution headers so
 * usage is credited through AI/ML API's rebate program.
 */
export class AimlapiProvider extends OpenAiProvider {
  constructor(options: AimlapiProviderOptions) {
    super({
      ...options,
      id: options.id,
      // OpenAiProvider normalizes the base URL.
      baseUrl: options.baseUrl ?? DEFAULT_AIMLAPI_BASE,
      defaultChatModel: options.defaultChatModel,
      headers: { ...buildAimlapiAttributionHeaders(), ...options.headers },
    });
  }
}
