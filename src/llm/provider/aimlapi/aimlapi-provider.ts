import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_AIMLAPI_BASE = "https://api.aimlapi.com";

/** Strips a trailing `/v1` so paths are not doubled (`/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeAimlapiBaseUrl } from "../openai/normalize-openai-base-url.js";

/**
 * Partner attribution AI/ML API records against its rebate_partners
 * registry. X-AIMLAPI-Partner-ID is intentionally left unset unless
 * AIMLAPI_PARTNER_ID is provided — it must be a `part_...` id minted
 * for this integration via `POST /v3/rebate-partners`, not a value we
 * can invent here.
 */
function buildAimlapiAttributionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-AIMLAPI-Source": "agent/atomic-agent",
  };
  const partnerId = process.env.AIMLAPI_PARTNER_ID?.trim();
  if (partnerId) {
    headers["X-AIMLAPI-Partner-ID"] = partnerId;
  }
  return headers;
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
