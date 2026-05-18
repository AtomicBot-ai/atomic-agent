/**
 * Memory-eval self-contained LLM client. Speaks the llama.cpp
 * `/completion` endpoint directly — no `getConfig()` dependency.
 *
 * Returns a `llmComplete` function that matches the
 * `ReflectionLlmComplete` shape from `src/memory/reflection/reflection-runner.ts`
 * so the reflection and distill runners can be plugged in unchanged.
 *
 * Deliberately tiny — we do not need streaming, retries, or KV-slot
 * tracking for eval. The reflection / distill calls are short and
 * cold-path; reliability comes from the model, not the wrapper.
 */

export interface LlmCompleteParams {
  prompt: string;
  grammar?: string;
  slotId?: number;
  sessionId?: string;
  signal?: AbortSignal;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  stop?: readonly string[];
  cachePrompt?: boolean;
  repeatPenalty?: number;
  seed?: number;
}

export interface LlmCompleteResult {
  content: string;
  reasoningContent: string;
  /** Wall-clock duration of the HTTP call. */
  durationMs: number;
  /** Token counts when llama-server reports them. */
  promptTokens: number | null;
  predictedTokens: number | null;
}

export interface LlmClientOptions {
  /** Base URL of the chat llama-server (e.g. `http://127.0.0.1:18991`). */
  baseUrl: string;
  /** Hard timeout per request. Defaults to 60 s. */
  timeoutMs?: number;
  /** API key for hosted providers (rarely used in eval). */
  apiKey?: string | null;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export class LlmClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
  ) {
    super(message);
    this.name = "LlmClientError";
  }
}

/**
 * Build a llmComplete adapter compatible with `ReflectionLlmComplete`
 * and `DistillRunnerDeps.llmComplete`. The returned function is
 * stateless and safe to share across concurrent calls.
 */
export function createLlmComplete(opts: LlmClientOptions): (params: LlmCompleteParams) => Promise<LlmCompleteResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  return async function llmComplete(params) {
    const url = `${baseUrl}/completion`;
    const payload: Record<string, unknown> = {
      prompt: params.prompt,
      stream: false,
      cache_prompt: params.cachePrompt ?? true,
      temperature: params.temperature ?? 0.2,
      top_p: params.topP ?? 0.95,
      top_k: params.topK ?? 40,
      n_predict: params.maxTokens ?? 2048,
      repeat_penalty: params.repeatPenalty ?? 1.1,
      repeat_last_n: 256,
    };
    if (params.grammar) payload.grammar = params.grammar;
    if (params.stop) payload.stop = [...params.stop];
    if (typeof params.seed === "number") payload.seed = params.seed;
    if (typeof params.slotId === "number") {
      payload.slot_id = params.slotId;
      payload.id_slot = params.slotId;
    }

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) controller.abort();
      else params.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new LlmClientError(
          `llama-server http ${response.status}: ${text.slice(0, 200)}`,
          response.status,
          url,
        );
      }
      const json = (await response.json()) as Record<string, unknown>;
      const content = typeof json.content === "string" ? json.content : "";
      const reasoning =
        typeof json.reasoning_content === "string" ? json.reasoning_content : "";
      const timing = (json.timings ?? {}) as {
        prompt_n?: number;
        predicted_n?: number;
      };
      return {
        content,
        reasoningContent: reasoning,
        durationMs: Date.now() - startedAt,
        promptTokens: typeof timing.prompt_n === "number" ? timing.prompt_n : null,
        predictedTokens:
          typeof timing.predicted_n === "number" ? timing.predicted_n : null,
      };
    } catch (err) {
      if (err instanceof LlmClientError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlmClientError(message, null, url);
    } finally {
      clearTimeout(timer);
      if (params.signal) params.signal.removeEventListener("abort", onExternalAbort);
    }
  };
}
