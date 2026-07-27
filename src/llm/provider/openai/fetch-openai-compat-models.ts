/**
 * Model discovery for OpenAI-compatible servers (vLLM, llama-server, LM Studio,
 * OpenAI itself): `GET {baseUrl}/v1/models`. The wizard reads the result
 * synchronously through the module cache, same shape as the OpenRouter picker.
 */

const cache = new Map<string, readonly string[]>();

/** Callers append `/v1/...`, so a base URL pasted with `/v1` must lose it. */
export function normalizeOpenAiCompatBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d+$/, "");
}

export function getCachedOpenAiCompatModels(
  baseUrl: string,
): readonly string[] | undefined {
  return cache.get(normalizeOpenAiCompatBaseUrl(baseUrl));
}

/** Throws on unreachable/unauthorized servers so the caller can fall back to typing. */
export async function fetchOpenAiCompatModels(
  baseUrl: string,
  apiKey?: string,
): Promise<readonly string[]> {
  const base = normalizeOpenAiCompatBaseUrl(baseUrl);
  const cached = cache.get(base);
  if (cached) return cached;

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

  cache.set(base, ids);
  return ids;
}
