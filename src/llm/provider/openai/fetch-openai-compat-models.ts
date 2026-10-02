/**
 * Model discovery for OpenAI-compatible servers (vLLM, llama-server, LM Studio,
 * OpenAI itself): `GET {baseUrl}/v1/models`. The wizard reads the result
 * synchronously through the module cache, same shape as the OpenRouter picker.
 */

import {
  buildOpenAiAuthHeaders,
  type OpenAiCompatAuth,
} from "./openai-auth-headers.js";
import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";
import { providerErrorSentence } from "./openai-http.js";
import { redactProviderDetail } from "../verify/redact-provider-detail.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { fetchedAt: number; ids: readonly string[] }>();

/** The key is part of the identity: an anonymous list must not serve an authenticated request. */
function cacheKey(baseUrl: string, apiKey?: string): string {
  return `${normalizeOpenAiBaseUrl(baseUrl)}\n${apiKey ?? ""}`;
}

export function getCachedOpenAiCompatModels(
  baseUrl: string,
  apiKey?: string,
): readonly string[] | undefined {
  const hit = cache.get(cacheKey(baseUrl, apiKey));
  if (!hit || Date.now() - hit.fetchedAt > CACHE_TTL_MS) return undefined;
  return hit.ids;
}

/**
 * Cache lookup by base URL alone, for read-only UI surfaces (the LLM
 * panel's inline model list) that know a provider's URL but not which
 * API key fetched the list. The strict keyed lookup above exists so an
 * anonymous *fetch* never reuses an authenticated response; a panel that
 * merely renders ids already stored on this machine leaks nothing, so
 * here the freshest entry for the URL wins regardless of key.
 */
export function getCachedOpenAiCompatModelsForBaseUrl(
  baseUrl: string,
): readonly string[] | undefined {
  const prefix = `${normalizeOpenAiBaseUrl(baseUrl)}\n`;
  let best: { fetchedAt: number; ids: readonly string[] } | undefined;
  for (const [key, hit] of cache) {
    if (!key.startsWith(prefix)) continue;
    if (Date.now() - hit.fetchedAt > CACHE_TTL_MS) continue;
    if (!best || hit.fetchedAt > best.fetchedAt) best = hit;
  }
  return best?.ids;
}

/**
 * Throws on unreachable/unauthorized servers so the caller can fall back to typing.
 *
 * `auth` describes how this endpoint wants credentials presented; both a
 * `ProviderPreset` and a saved `UserLlmProviderEntry` satisfy it
 * structurally, so callers pass whichever they hold. It is deliberately
 * **not** part of the cache key: the header contract is a property of the
 * endpoint, so the same base URL always implies the same headers, and
 * keying on it would only fragment the cache that the read-only lookups
 * (which know a URL and a key, never a header set) share.
 */
export async function fetchOpenAiCompatModels(
  baseUrl: string,
  apiKey?: string,
  auth?: OpenAiCompatAuth,
): Promise<readonly string[]> {
  const cached = getCachedOpenAiCompatModels(baseUrl, apiKey);
  if (cached) return cached;

  const base = normalizeOpenAiBaseUrl(baseUrl);
  const res = await fetch(`${base}/v1/models`, {
    headers: buildOpenAiAuthHeaders(apiKey, auth),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await modelListHttpError(res, apiKey);
  const json = (await res.json()) as { data?: readonly { id?: unknown }[] };
  const ids = (json.data ?? [])
    .map((row) => row?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) throw new Error("server listed no models");

  cache.set(cacheKey(baseUrl, apiKey), { fetchedAt: Date.now(), ids });
  return ids;
}

/**
 * A refused model-list request as `http <status>`, followed by the
 * provider's own sentence when the body had one: `http 400: Please pass a
 * valid API key`. The status alone hid which problem it was — Gemini
 * refuses a bad key with a 400, and Anthropic answers 401 both to a key in
 * the wrong header ("invalid x-api-key") and to a wrong key ("API key is
 * invalid."). The status stays first for callers that branch on it, and
 * the key is redacted in case the service quoted it back.
 */
export async function modelListHttpError(
  res: Response,
  apiKey: string | undefined,
): Promise<Error> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  const said = redactProviderDetail(providerErrorSentence(body), apiKey ?? "");
  return new Error(said ? `http ${res.status}: ${said}` : `http ${res.status}`);
}
