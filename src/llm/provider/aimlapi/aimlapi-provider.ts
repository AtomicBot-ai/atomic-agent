import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_AIMLAPI_BASE = "https://api.aimlapi.com";

/** Strips a trailing `/v1` so paths are not doubled (`/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeAimlapiBaseUrl } from "../openai/normalize-openai-base-url.js";

/**
 * Identifies the client, and nothing else.
 *
 * There was a `X-AIMLAPI-Partner-ID` beside this, defaulting to a
 * hardcoded partner id so that every request from every install was
 * credited to one account's rebate program. That is a revenue-attribution
 * tracker riding on the operator's own API key, switched on by default,
 * for a party the operator never chose — and an agent that ships one
 * without asking has spent trust it will need later for things that
 * matter more.
 *
 * What stays is the product name. `X-AIMLAPI-Source` is the same thing a
 * User-Agent is: it tells the service which client is calling so the
 * service can debug it, and it says nothing about who should be paid.
 */
export function buildAimlapiAttributionHeaders(): Record<string, string> {
  return { "X-AIMLAPI-Source": "agent/atomic-agent" };
}

export type AimlapiProviderOptions = Omit<OpenAiProviderOptions, "baseUrl"> & {
  baseUrl?: string;
};

/**
 * AI/ML API (aimlapi.com) is OpenAI-compatible; this thin wrapper sets
 * the default base URL and identifies the client. No partner or
 * referral id is attached — see `buildAimlapiAttributionHeaders`.
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
