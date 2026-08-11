import { OpenAiProvider, type OpenAiProviderOptions } from "../openai/openai-provider.js";

/** Root without `/v1` — {@link OpenAiProvider} appends `/v1/chat/completions`. */
export const DEFAULT_OPENROUTER_BASE = "https://openrouter.ai/api";

/**
 * App-attribution values sent on every OpenRouter request (chat and
 * embeddings). The referer is the app's stable identity on
 * openrouter.ai/apps, so it stays on the GitHub URL to keep one app page;
 * the title is the display name and the categories place us in the
 * marketplace boards. See https://openrouter.ai/docs/app-attribution.
 */
export const OPENROUTER_APP_REFERER = "https://github.com/AtomicBot-ai/atomic-agent";
export const OPENROUTER_APP_TITLE = "Atomic Agent";
export const OPENROUTER_APP_CATEGORIES = "cli-agent,personal-agent";

/** Strips a trailing `/v1` so paths are not doubled (`/api/v1/v1/...`). */
export { normalizeOpenAiBaseUrl as normalizeOpenRouterBaseUrl } from "../openai/normalize-openai-base-url.js";

export type OpenRouterProviderOptions = Omit<OpenAiProviderOptions, "baseUrl"> & {
  baseUrl?: string;
  httpReferer?: string;
  xTitle?: string;
  /** Comma-separated marketplace categories, e.g. `cli-agent,personal-agent`. */
  categories?: string;
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
    if (options.categories) {
      headers["X-OpenRouter-Categories"] = options.categories;
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
