/**
 * The one place that decides how an API key is attached to an outgoing
 * request for an `openai-compatible` endpoint.
 *
 * Both request paths — model discovery (`fetch-openai-compat-models.ts`)
 * and every chat/embedding call (`openai-http.ts`) — go through this
 * function so they cannot drift. They did drift in spirit before: each
 * hard-coded `Authorization: Bearer`, which is why a preset for a vendor
 * that authenticates any other way could 401 on discovery *and* on every
 * subsequent turn with nothing in config able to correct it.
 */

/**
 * How a service wants credentials presented. Both fields are optional and
 * the empty object reproduces the historical behaviour exactly:
 * `Authorization: Bearer <key>` and no extra headers.
 *
 * `ProviderPreset` and `UserLlmProviderEntry` both carry these two field
 * names, so a preset or a saved config entry can be passed straight in.
 */
export type OpenAiCompatAuth = {
  /**
   * Header that carries the API key verbatim, for services that do not
   * accept `Authorization: Bearer` (Anthropic wants `x-api-key`; a
   * `Bearer sk-ant-…` is read as an OAuth token and always rejected).
   * Absent means the OpenAI convention: `authorization: Bearer <key>`.
   */
  readonly apiKeyHeader?: string;
  /**
   * Static headers every request to the service must carry, e.g.
   * Anthropic's mandatory `anthropic-version`. Never holds secrets —
   * the key travels in `apiKeyHeader` (or the bearer default) so it can
   * keep coming from the environment instead of `config.json`.
   */
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * Headers that authenticate one request. Keyless servers (a local LM
 * Studio, an unauthenticated vLLM) get no auth header at all: `Bearer `
 * with an empty token is malformed and some proxies reject it outright.
 * The static `headers` still go out — a version header is part of the
 * request contract whether or not a key exists.
 */
export function buildOpenAiAuthHeaders(
  apiKey: string | undefined,
  auth: OpenAiCompatAuth | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (apiKey) {
    const named = auth?.apiKeyHeader?.trim();
    if (named) {
      out[named.toLowerCase()] = apiKey;
    } else {
      out.authorization = `Bearer ${apiKey}`;
    }
  }
  for (const [name, value] of Object.entries(auth?.headers ?? {})) {
    out[name.toLowerCase()] = value;
  }
  return out;
}
