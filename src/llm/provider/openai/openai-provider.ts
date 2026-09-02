import {
  VisionUnsupportedError,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderHealthResult,
  type VisionRequest,
  type VisionResult,
} from "../llm-provider.js";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  StreamFinalResult,
} from "../completion-types.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";
import type { StreamConsumer } from "../adapters/stream-consumer.js";
import type { ReasoningFormat } from "../llm-provider.js";
import { openAiToolCallAdapter } from "./openai-tool-call-adapter.js";
import { createOpenAiStreamConsumer } from "./openai-stream-consumer.js";
import { buildOpenAiChatBody } from "./openai-build-body.js";
import {
  buildOpenAiHeaders,
  openAiGetJson,
  openAiPostJson,
  openAiRetryBackoff,
  openAiStartStream,
  OpenAiHttpError,
  OPENAI_MAX_ATTEMPTS,
  type OpenAiHttpDeps,
} from "./openai-http.js";
import { isNetworkError } from "../../reliability/network-error.js";
import { normaliseOpenAiChatResponse } from "./openai-normalise-response.js";
import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";
import { describeImageViaOpenAi } from "./openai-describe-image.js";
import { adaptQwenCompletionResult, adaptQwenTaggedToolResponse } from "./qwen-tagged-tool-response-adapter.js";

export interface OpenAiProviderOptions {
  id: string;
  baseUrl: string;
  apiKey: string;
  defaultChatModel: string;
  headers?: Record<string, string>;
  /**
   * Header that carries the API key when the service does not accept
   * `Authorization: Bearer`. See `openai-auth-headers.ts`.
   */
  apiKeyHeader?: string;
  supportsVision?: boolean;
  supportsParallelTools?: boolean;
  supportsPromptCache?: boolean;
  reasoningFormat?: ReasoningFormat;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  toolCallAdapter?: ToolCallAdapter;
  streamConsumer?: StreamConsumer;
  apiPathPrefix?: string;
  taggedToolCompatibility?: "qwen";
  /**
   * Vendor-specific fields merged into every chat completion body.
   * See `RESERVED_BODY_KEYS` in `openai-build-body.ts` for the keys
   * this passthrough cannot override.
   */
  extraBody?: Record<string, unknown>;
}

export class OpenAiProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly toolCallAdapter: ToolCallAdapter;
  readonly streamConsumer: StreamConsumer;
  readonly capabilities: ProviderCapabilities;

  private readonly http: OpenAiHttpDeps;
  private readonly defaultChatModel: string;
  private readonly apiPathPrefix: string;
  private readonly taggedToolCompatibility: "qwen" | undefined;
  private readonly extraBody: Record<string, unknown> | undefined;

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id;
    this.name = options.id;
    this.toolCallAdapter = options.toolCallAdapter ?? openAiToolCallAdapter;
    this.streamConsumer = options.streamConsumer ??
      createOpenAiStreamConsumer(options.reasoningFormat ?? "delta_reasoning");
    this.capabilities = {
      vision: options.supportsVision ?? true,
      visionSource: options.supportsVision ? "modalities.vision" : "absent",
      toolTransport: "native_tools",
      contextWindow: 128_000,
      supportsParallelTools: options.supportsParallelTools ?? true,
      supportsSlotAffinity: false,
      supportsPromptCache: options.supportsPromptCache ?? true,
      reasoningFormat: options.reasoningFormat ?? "delta_reasoning",
    };
    this.defaultChatModel = options.defaultChatModel;
    this.apiPathPrefix = normalizeApiPathPrefix(options.apiPathPrefix ?? "/v1");
    this.taggedToolCompatibility = options.taggedToolCompatibility;
    this.extraBody = options.extraBody;
    this.http = {
      baseUrl: normalizeOpenAiBaseUrl(options.baseUrl),
      apiKey: options.apiKey,
      extraHeaders: options.headers ?? {},
      ...(options.apiKeyHeader ? { apiKeyHeader: options.apiKeyHeader } : {}),
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      fetchImpl: options.fetchImpl ?? fetch,
      label: options.id,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = buildOpenAiChatBody(request, this.defaultChatModel, false, this.extraBody);
    const json = await openAiPostJson(
      this.http,
      `${this.apiPathPrefix}/chat/completions`,
      body,
      request,
    );
    const adapted =
      this.taggedToolCompatibility === "qwen"
        ? adaptQwenTaggedToolResponse(json, request)
        : json;
    return normaliseOpenAiChatResponse(adapted, this.defaultChatModel);
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const body = buildOpenAiChatBody(request, this.defaultChatModel, true, this.extraBody);
    const path = `${this.apiPathPrefix}/chat/completions`;
    let accumulated = "";
    let accumulatedReasoning = "";
    let streamFinal: StreamFinalResult | void = undefined;
    // Flipped the instant the first chunk leaves this generator. Before
    // that the caller has seen nothing, so throwing the half-opened
    // stream away and starting over is invisible to everyone — the same
    // argument `openAiStartStream` makes for retrying the open. After
    // it, the stream is COMMITTED: a restart would replay the completion
    // from the top and duplicate text the user already read, and because
    // sampling is non-deterministic no prefix dedupe can repair that.
    let committed = false;

    // The window this loop exists for: a provider answers 2xx, thinks for
    // a long time (reasoning models, cold routes), then drops the socket
    // without ever emitting a delta. `openAiStartStream` has already
    // returned by then, so its retry is spent, and undici surfaces the
    // death as a bare `Error: terminated` from the body reader — which
    // used to fail the whole turn ("Turn failed [transport]: terminated")
    // even though not one byte of output existed.
    attempts: for (let attempt = 1; ; attempt += 1) {
      let res: (Response & { body: NonNullable<Response["body"]> }) | undefined;
      try {
        // Opening the stream (connect + status check) happens inside the
        // client's bounded retry, strictly before the first chunk exists.
        res = await openAiStartStream(this.http, path, body, request);
        // A reopen starts from an empty transcript: whatever the dead
        // attempt accumulated was never yielded and must not be mixed
        // into the fresh one.
        accumulated = "";
        accumulatedReasoning = "";
        streamFinal = undefined;
        const stream = this.streamConsumer.consume(res.body, request.signal);
        while (true) {
          const next = await stream.next();
          if (next.done) {
            streamFinal = next.value;
            break attempts;
          }
          const chunk = next.value;
          if (chunk.delta) accumulated += chunk.delta;
          if (chunk.reasoningDelta) accumulatedReasoning += chunk.reasoningDelta;
          if (!chunk.done) {
            committed = true;
            yield chunk;
          }
        }
      } catch (err) {
        if (!canReopenStream(err, request.signal, committed, attempt)) throw err;
        // Hand the dead socket back before opening a new one, or the
        // retry leaks a connection out of undici's pool for the rest of
        // the process.
        await discardResponseBody(res);
        await openAiRetryBackoff(attempt, request.signal);
      }
    }
    const final = completionFromStreamFinal(
      streamFinal,
      this.defaultChatModel,
      accumulated,
      accumulatedReasoning,
    );
    if (accumulated.length > 0 && final.content.length === 0) {
      final.content = accumulated;
    }
    if (accumulatedReasoning.length > 0 && final.reasoningContent.length === 0) {
      final.reasoningContent = accumulatedReasoning;
    }
    // Tagged Qwen calls are synthesized only after the stream has been
    // fully buffered. Apply termination safety after that adaptation seam,
    // so native and tagged calls are judged from the same final dispatchable
    // tool-call set. A synthetic `finishReason: "tool_calls"` from the
    // adapter is not evidence that the provider actually terminated cleanly.
    const adaptedFinal =
      this.taggedToolCompatibility === "qwen"
        ? adaptQwenCompletionResult(final, request)
        : final;
    return applyToolCallTerminationSafety(
      adaptedFinal,
      streamFinal?.terminalObserved === true,
    );
  }

  async health(): Promise<ProviderHealthResult> {
    const start = Date.now();
    try {
      const res = await this.http.fetchImpl(`${this.http.baseUrl}${this.apiPathPrefix}/models`, {
        method: "GET",
        headers: buildOpenAiHeaders(this.http, false),
      });
      return {
        reachable: res.ok,
        status: res.status,
        error: res.ok ? null : `http ${res.status}`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to tear down.
  }

  async describeImage(request: VisionRequest): Promise<VisionResult> {
    if (!this.capabilities.vision) {
      throw new VisionUnsupportedError(this.name);
    }
    return describeImageViaOpenAi(
      this.http,
      this.defaultChatModel,
      request,
      this.apiPathPrefix,
    );
  }

  async listModels(): Promise<readonly string[]> {
    const json = await openAiGetJson(this.http, `${this.apiPathPrefix}/models`);
    const data = (json.data as Array<{ id?: string }> | undefined) ?? [];
    return data.map((row) => row.id).filter((id): id is string => typeof id === "string");
  }
}

function normalizeApiPathPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function completionFromStreamFinal(
  streamFinal: StreamFinalResult | void,
  defaultChatModel: string,
  accumulated: string,
  accumulatedReasoning: string,
): CompletionResult {
  const usage = streamFinal?.usage ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const finishReason = streamFinal?.finishReason ?? null;
  return {
    content: streamFinal?.content ?? accumulated,
    reasoningContent: streamFinal?.reasoningContent ?? accumulatedReasoning,
    stop: finishReason !== "length",
    truncated: finishReason === "length",
    timing: {
      promptMs: 0,
      predictedMs: 0,
      promptTokens: usage.promptTokens,
      predictedTokens: usage.completionTokens,
    },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: streamFinal?.modelId ?? defaultChatModel,
    usage,
    toolCalls: streamFinal?.toolCalls,
    finishReason,
  };
}

/**
 * May a failure raised between "2xx headers received" and "first chunk
 * handed to our caller" be recovered by reopening the stream?
 *
 * The order of these guards is the contract, not a stylistic choice:
 *
 * 1. **Committed.** Once a chunk has been yielded, nothing below matters.
 *    This is deliberately the strictest reading of "output": a chunk that
 *    carries only the provider's opening `role` delta commits the stream
 *    just as a text delta does. We cannot know what a downstream consumer
 *    did with it, and being wrong here means duplicating a user's reply.
 *    Reasoning deltas are output for the same reason — the TUI renders
 *    them live.
 * 2. **Cancellation.** A user pressing Esc is not a network failure, and
 *    an abort reaches us in several disguises (`AbortError`, a raw
 *    `Error: aborted`, or a custom `fetchImpl`'s own shape). The signal
 *    is the only reliable oracle, so it is consulted before the error is
 *    inspected at all — the ordering `network-error.ts` documents.
 * 3. **`OpenAiHttpError`.** The failure came from *opening* the stream,
 *    which already ran inside `runOpenAiWithRetry` and already spent the
 *    whole `OPENAI_MAX_ATTEMPTS` budget on 429s/5xx/connect errors.
 *    Retrying it here would silently square the budget (3 × 3) and delay
 *    a real, actionable message — a bad API key would be tried nine
 *    times. Only untyped body-read deaths get past this guard.
 * 4. **Shape.** Anything that is not a recognisable transport death — a
 *    bug in a stream consumer, a parse error — is a real error. Replaying
 *    it would just hide it behind three identical failures.
 * 5. **Budget.** One streaming completion gets `OPENAI_MAX_ATTEMPTS`
 *    total, shared with the open, not a fresh budget per layer.
 */
function canReopenStream(
  err: unknown,
  signal: AbortSignal | undefined,
  committed: boolean,
  attempt: number,
): boolean {
  if (committed) return false;
  if (signal?.aborted) return false;
  if (err instanceof OpenAiHttpError) return false;
  if (!isNetworkError(err)) return false;
  return attempt < OPENAI_MAX_ATTEMPTS;
}

/**
 * Release a response whose body died mid-read, so the reopen does not
 * leak the socket. By the time we get here the stream consumer's
 * `finally` has released its reader lock, but the body itself still owns
 * the connection until it is cancelled. A body that refuses to cancel
 * (already errored, still locked) is not worth failing the turn over —
 * we are on our way to a fresh request either way.
 */
async function discardResponseBody(res: Response | undefined): Promise<void> {
  if (!res?.body) return;
  try {
    await res.body.cancel();
  } catch {
    // Nothing left to release.
  }
}

function applyToolCallTerminationSafety(
  result: CompletionResult,
  terminalObserved: boolean,
): CompletionResult {
  const hasToolCalls = (result.toolCalls?.length ?? 0) > 0;
  if (!hasToolCalls || terminalObserved || result.truncated) {
    return result;
  }
  return {
    ...result,
    stop: false,
    truncated: true,
  };
}
