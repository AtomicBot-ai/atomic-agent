import { createHash } from "node:crypto";
import { discardResponseBody } from "./discard-response-body.js";
import { llamaEndpointUrl } from "./llama-endpoint-url.js";
import type { TokenCounter } from "./token-counter.js";

/**
 * A step waits on this before its inference, so it must stay short: a
 * tokenize of a long history on a local server answers in milliseconds,
 * and anything slower is better replaced by the heuristic than waited for.
 */
export const LLAMA_TOKENIZE_TIMEOUT_MS = 1_500;

/** Counts kept per counter; a decision re-asks only about the same history. */
export const LLAMA_TOKENIZE_CACHE_ENTRIES = 32;

export interface LlamaTokenizeCounterOptions {
  /** The llama-server base URL (a trailing `/v1` is dropped). Read per call. */
  baseUrl(): string;
  /** The bearer key for that server, when it has one. Read per call. */
  apiKey?(): string | null | undefined;
  /**
   * Names what is loaded behind the URL, so a model swap on the same port
   * does not reuse another tokenizer's counts. Read per call.
   */
  modelKey?(): string;
  timeoutMs?: number;
  cacheEntries?: number;
  fetch?: typeof fetch;
}

/**
 * Exact counts from llama-server's `/tokenize`, cached by a hash of the
 * server, model and text. Any failure (no server, timeout, a non-OK
 * answer, an unexpected body) is `null`, so the caller keeps the heuristic.
 * A server that answers 404 or 501 has no such endpoint: it is not asked
 * again for the life of the counter.
 */
export function createLlamaTokenizeCounter(options: LlamaTokenizeCounterOptions): TokenCounter {
  const cache = new Map<string, number>();
  const unsupported = new Set<string>();
  const limit = Math.max(1, options.cacheEntries ?? LLAMA_TOKENIZE_CACHE_ENTRIES);
  const timeoutMs = options.timeoutMs ?? LLAMA_TOKENIZE_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  return {
    async count(text, signal) {
      if (text.length === 0) return 0;
      let url: string;
      try {
        url = llamaEndpointUrl(options.baseUrl(), "/tokenize");
      } catch {
        return null;
      }
      if (unsupported.has(url)) return null;
      const key = createHash("sha256").update(url).update("\0").update(options.modelKey?.() ?? "").update("\0").update(text).digest("hex");
      const cached = cache.get(key);
      if (cached !== undefined) {
        // Most recent last, so the oldest entry is the one evicted.
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      if (signal?.aborted) return null;
      const apiKey = options.apiKey?.();
      const deadline = AbortSignal.timeout(timeoutMs);
      let response: Response | undefined;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          // The prompt is sent already framed, so special tokens are not added here.
          body: JSON.stringify({ content: text, add_special: false }),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 501) unsupported.add(url);
          discardResponseBody(response);
          return null;
        }
        const body: unknown = await response.json();
        const tokens = (body as { tokens?: unknown } | null)?.tokens;
        if (!Array.isArray(tokens)) return null;
        cache.set(key, tokens.length);
        while (cache.size > limit) cache.delete(cache.keys().next().value!);
        return tokens.length;
      } catch {
        discardResponseBody(response);
        return null;
      }
    },
  };
}
