/**
 * Model discovery for OpenAI-compatible servers (vLLM, llama-server, LM Studio,
 * OpenAI itself): `GET {baseUrl}/v1/models`. The wizard reads the result
 * synchronously through the module cache, same shape as the OpenRouter picker.
 */

import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";

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

/** Throws on unreachable/unauthorized servers so the caller can fall back to typing. */
export async function fetchOpenAiCompatModels(
  baseUrl: string,
  apiKey?: string,
): Promise<readonly string[]> {
  const cached = getCachedOpenAiCompatModels(baseUrl, apiKey);
  if (cached) return cached;

  const base = normalizeOpenAiBaseUrl(baseUrl);
  const res = await fetch(`${base}/v1/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = (await res.json()) as { data?: readonly { id?: unknown }[] };
  const ids = (json.data ?? [])
    .map((row) => row?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) throw new Error("server listed no models");

  cache.set(cacheKey(baseUrl, apiKey), { fetchedAt: Date.now(), ids });
  return ids;
}
