/**
 * Model discovery for Gemini's OpenAI-compatible surface:
 * `GET {DEFAULT_GEMINI_BASE}{GEMINI_API_PATH_PREFIX}/models`.
 * Mirrors the openai-compatible module cache so repeated Cloud-pane
 * visits stay free within the TTL and a cold fetch surfaces a visible
 * loading state before `loaded`/`failed`.
 */

import {
  DEFAULT_GEMINI_BASE,
  GEMINI_API_PATH_PREFIX,
} from "./gemini-provider.js";

const CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { fetchedAt: number; ids: readonly string[] }>();

/** The key is part of the identity: an anonymous list must not serve an authenticated request. */
function cacheKey(apiKey?: string): string {
  return apiKey ?? "";
}

export function getCachedGeminiModels(
  apiKey?: string,
): readonly string[] | undefined {
  const hit = cache.get(cacheKey(apiKey));
  if (!hit || Date.now() - hit.fetchedAt > CACHE_TTL_MS) return undefined;
  return hit.ids;
}

/** Throws on unreachable/unauthorized servers so the caller can surface failure. */
export async function fetchGeminiModels(
  apiKey?: string,
): Promise<readonly string[]> {
  const cached = getCachedGeminiModels(apiKey);
  if (cached) return cached;

  const res = await fetch(
    `${DEFAULT_GEMINI_BASE}${GEMINI_API_PATH_PREFIX}/models`,
    {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = (await res.json()) as { data?: readonly { id?: unknown }[] };
  const ids = (json.data ?? [])
    .map((row) => row?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort((a, b) => a.localeCompare(b));
  if (ids.length === 0) throw new Error("server listed no models");

  cache.set(cacheKey(apiKey), { fetchedAt: Date.now(), ids });
  return ids;
}
