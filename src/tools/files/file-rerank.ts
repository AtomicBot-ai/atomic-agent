import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";

/** One document's new place: its index in the list sent, and the model's score. */
export interface RerankScore {
  index: number;
  score: number;
}

/**
 * A cross-encoder that re-orders search candidates (ATO-1052). Answers
 * `null` whenever it cannot help (down, slow, a bad answer): the caller
 * keeps its own order then.
 */
export interface Reranker {
  rerank(query: string, documents: readonly string[], signal?: AbortSignal): Promise<RerankScore[] | null>;
}

/** The variable that turns reranking on; documented in `config/env-settings.ts`. */
export const RERANK_URL_ENV = "ATOMIC_AGENT_RERANK_URL";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Longest document text sent; rerankers truncate to their context anyway. */
export const RERANK_DOCUMENT_CHARS = 2000;

/** `http://host:port` → `http://host:port/v1/rerank`; a URL already ending in `/rerank` is kept. */
export function rerankEndpoint(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/\/rerank$/.test(trimmed)) return trimmed;
  return /\/v1$/.test(trimmed) ? `${trimmed}/rerank` : `${trimmed}/v1/rerank`;
}

/**
 * A reranker behind a llama-server style `POST /v1/rerank`
 * (`{ query, documents, top_n }` in, `{ results: [{ index, relevance_score }] }`
 * out; Jina and Cohere answer the same shape).
 */
export function createHttpReranker(options: {
  url: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Reranker {
  const endpoint = rerankEndpoint(options.url);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async rerank(query, documents, signal) {
      if (documents.length === 0) return [];
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        const response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(options.model ? { model: options.model } : {}),
            query,
            documents: documents.map((text) => text.slice(0, RERANK_DOCUMENT_CHARS)),
            top_n: documents.length,
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) return null;
        return parseRerankResponse(await response.json(), documents.length);
      } catch {
        return null;
      }
    },
  };
}

/** Valid, distinct indices only; `null` when nothing usable came back. */
export function parseRerankResponse(body: unknown, count: number): RerankScore[] | null {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return null;
  const seen = new Set<number>();
  const out: RerankScore[] = [];
  for (const item of results) {
    const index = (item as { index?: unknown })?.index;
    const raw = (item as { relevance_score?: unknown; score?: unknown })?.relevance_score ?? (item as { score?: unknown })?.score;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count || seen.has(index)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    seen.add(index);
    out.push({ index, score: raw });
  }
  return out.length === 0 ? null : out.sort((a, b) => b.score - a.score);
}

/**
 * The reranker `ATOMIC_AGENT_RERANK_URL` names, or `null` (the default:
 * off). Only a server on this machine or the local network is used,
 * since file text is sent to it; any other URL is ignored with a warning.
 */
export function rerankerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void = () => {},
): Reranker | null {
  const url = env["ATOMIC_AGENT_RERANK_URL"]?.trim();
  if (!url) return null;
  if (!isLocalServerUrl(url)) {
    warn(`${RERANK_URL_ENV} is not a local server; reranking stays off so file text stays on this machine`);
    return null;
  }
  return createHttpReranker({ url });
}

/**
 * Re-order `items` by the reranker's scores over `texts` (same order).
 * Items it scored come first, by score; the rest keep their order after
 * them. The original order when it answers `null`.
 */
export async function applyRerank<T>(
  reranker: Reranker,
  query: string,
  items: readonly T[],
  texts: readonly string[],
  signal?: AbortSignal,
): Promise<{ item: T; score: number | null }[]> {
  const plain = items.map((item) => ({ item, score: null as number | null }));
  if (items.length < 2) return plain;
  const scores = await reranker.rerank(query, texts, signal);
  if (scores === null) return plain;
  const placed = new Set(scores.map((s) => s.index));
  return [
    ...scores.map((s) => ({ item: items[s.index]!, score: s.score })),
    ...plain.filter((_, i) => !placed.has(i)),
  ];
}
