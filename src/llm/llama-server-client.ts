import { getConfig } from "../config/index.js";

export interface CompletionRequest {
  prompt: string;
  grammar?: string;
  slotId?: number;
  cachePrompt?: boolean;
  stop?: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  seed?: number;
  /** Stable key hashed with the prefix so we always reuse the same slot. */
  sessionId?: string;
}

export interface CompletionTiming {
  promptMs: number;
  predictedMs: number;
  promptTokens: number;
  predictedTokens: number;
}

export interface CompletionResult {
  content: string;
  /**
   * Optional reasoning stream, populated when llama-server exposes a
   * dedicated `reasoning_content` field (e.g. QwQ, DeepSeek-R1 with
   * `--reasoning-format deepseek`). Empty string for legacy builds or
   * non-reasoning models — in that case the step executor still falls
   * back to `<think>...</think>` extraction from `content`.
   */
  reasoningContent: string;
  stop: boolean;
  truncated: boolean;
  timing: CompletionTiming;
  cacheHitTokens: number;
  slotId: number;
  modelId: string | null;
}

export interface StreamChunk {
  delta: string;
  /**
   * Incremental reasoning text from the same SSE frame. Non-empty only
   * when the server chose to split CoT into its own `reasoning_content`
   * channel; otherwise reasoning still arrives inline in `delta` as a
   * `<think>...</think>` block and is recovered by the grammar parser.
   */
  reasoningDelta: string;
  done: boolean;
}

export class LlamaServerError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
  ) {
    super(message);
    this.name = "LlamaServerError";
  }
}

export interface LlamaServerClientOptions {
  baseUrl?: string;
  apiKey?: string | null;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface LlamaServerProps {
  [key: string]: unknown;
}

/**
 * HTTP client for an external llama-server. Exposes a single unary
 * `complete()` and a streaming `completeStream()` — both hand a GBNF grammar
 * and a reusable slot_id to llama.cpp for KV-cache reuse.
 */
export class LlamaServerClient {
  /** When set, this fixed base wins; otherwise each request reads `getConfig().llama.url`. */
  private readonly baseUrlOverride: string | undefined;
  private readonly apiKey: string | null;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LlamaServerClientOptions = {}) {
    const config = getConfig();
    this.baseUrlOverride = options.baseUrl;
    this.apiKey = options.apiKey ?? config.llama.apiKey;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? config.llama.requestTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchProps(): Promise<LlamaServerProps> {
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.llama.url;
    const url = new URL("/props", base).toString();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.buildHeaders(false),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LlamaServerError(
          `llama-server returned http ${response.status}`,
          response.status,
          url,
        );
      }
      return (await response.json()) as LlamaServerProps;
    } catch (err) {
      if (err instanceof LlamaServerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlamaServerError(message, null, url);
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { url, headers, body } = this.prepareRequest(request, false);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new LlamaServerError(
          `llama-server returned http ${response.status}`,
          response.status,
          url,
        );
      }
      const json = (await response.json()) as Record<string, unknown>;
      return normaliseCompletionResponse(json);
    } catch (err) {
      if (err instanceof LlamaServerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlamaServerError(message, null, url);
    } finally {
      clearTimeout(timer);
    }
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const { url, headers, body } = this.prepareRequest(request, true);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    let finalResult: CompletionResult = {
      content: "",
      reasoningContent: "",
      stop: false,
      truncated: false,
      timing: {
        promptMs: 0,
        predictedMs: 0,
        promptTokens: 0,
        predictedTokens: 0,
      },
      cacheHitTokens: 0,
      slotId: request.slotId ?? -1,
      modelId: null,
    };
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new LlamaServerError(
          `llama-server returned http ${response.status}`,
          response.status,
          url,
        );
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      let accumulated = "";
      let accumulatedReasoning = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let eventEnd = buffer.indexOf("\n\n");
        while (eventEnd !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          const parsed = parseSseEvent(rawEvent);
          if (parsed) {
            const delta =
              typeof parsed.content === "string" ? parsed.content : "";
            const reasoningDelta =
              typeof parsed.reasoning_content === "string"
                ? parsed.reasoning_content
                : "";
            if (delta.length > 0 || reasoningDelta.length > 0) {
              accumulated += delta;
              accumulatedReasoning += reasoningDelta;
              yield { delta, reasoningDelta, done: false };
            }
            if (parsed.stop) {
              finalResult = normaliseCompletionResponse(parsed);
              if (finalResult.content.length === 0) {
                finalResult.content = accumulated;
              }
              if (finalResult.reasoningContent.length === 0) {
                finalResult.reasoningContent = accumulatedReasoning;
              }
              yield { delta: "", reasoningDelta: "", done: true };
            }
          }
          eventEnd = buffer.indexOf("\n\n");
        }
      }
      return finalResult;
    } catch (err) {
      if (err instanceof LlamaServerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlamaServerError(message, null, url);
    } finally {
      clearTimeout(timer);
    }
  }

  private prepareRequest(
    request: CompletionRequest,
    stream: boolean,
  ): { url: string; headers: Record<string, string>; body: string } {
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.llama.url;
    const url = new URL(config.llama.completionPath, base).toString();
    const headers = this.buildHeaders(stream);
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      stream,
      cache_prompt: request.cachePrompt ?? true,
      temperature: request.temperature ?? 0.2,
      top_p: request.topP ?? 0.95,
      top_k: request.topK ?? 40,
      n_predict: request.maxTokens ?? config.llama.completionMaxTokens,
    };
    if (request.grammar) payload.grammar = request.grammar;
    if (request.stop) payload.stop = request.stop;
    if (typeof request.seed === "number") payload.seed = request.seed;
    if (typeof request.slotId === "number") {
      payload.slot_id = request.slotId;
      payload.id_slot = request.slotId;
    }
    const body = JSON.stringify(payload);
    return { url, headers, body };
  }

  private buildHeaders(stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }
}

function parseSseEvent(rawEvent: string): Record<string, unknown> | null {
  const lines = rawEvent.split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join("\n");
  if (joined === "[DONE]") return null;
  try {
    return JSON.parse(joined) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normaliseCompletionResponse(
  payload: Record<string, unknown>,
): CompletionResult {
  const timings = (payload.timings ?? {}) as Record<string, unknown>;
  return {
    content: typeof payload.content === "string" ? payload.content : "",
    reasoningContent:
      typeof payload.reasoning_content === "string"
        ? payload.reasoning_content
        : "",
    stop: Boolean(payload.stop),
    truncated: Boolean(payload.truncated),
    timing: {
      promptMs: toNumber(timings.prompt_ms),
      predictedMs: toNumber(timings.predicted_ms),
      promptTokens: toNumber(timings.prompt_n ?? payload.tokens_evaluated),
      predictedTokens: toNumber(timings.predicted_n ?? payload.tokens_predicted),
    },
    cacheHitTokens: toNumber(payload.tokens_cached),
    slotId: toNumber(payload.slot_id ?? payload.id_slot, -1),
    modelId:
      typeof payload.model === "string" ? payload.model : null,
  };
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
