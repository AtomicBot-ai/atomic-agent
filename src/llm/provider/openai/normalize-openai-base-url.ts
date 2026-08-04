/**
 * Every OpenAI-compatible call site appends `/v1/...`, so a base URL stored
 * with a trailing `/v1` — pasted into the wizard or hand-edited into
 * `config.json` — must lose it, or requests go to `/v1/v1/chat/completions`.
 * Only `/v1` is stripped: `https://host/api/v2` is a different API root, not
 * a doubled version segment.
 */
export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}
