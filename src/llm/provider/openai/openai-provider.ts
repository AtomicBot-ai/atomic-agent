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
  createOpenAiAttemptBudget,
  openAiGetJson,
  openAiPostJson,
  openAiRetryBackoff,
  openAiStartStream,
  OpenAiHttpError,
  OPENAI_MAX_ATTEMPTS,
  type OpenAiAttemptBudget,
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
    // One completion, one budget. Passed into every open so a reopen
    // draws from the same pot the opens do — the alternative is two
    // nested loops of `OPENAI_MAX_ATTEMPTS` and 9 requests per turn.
    const budget = createOpenAiAttemptBudget();
    // Distinguishes "the loop finished a stream" from "the loop ran out
    // of iterations", which is what makes the bound below safe to add.
    let streamEnded = false;

    // The window this loop exists for: a provider answers 2xx, thinks for
    // a long time (reasoning models, cold routes), then drops the socket
    // without ever emitting a delta. `openAiStartStream` has already
    // returned by then, so its retry is spent, and undici surfaces the
    // death as a bare `Error: terminated` from the body reader — which
    // used to fail the whole turn ("Turn failed [transport]: terminated")
    // even though not one byte of output existed.
    //
    // The `attempt <= OPENAI_MAX_ATTEMPTS` bound is a structural
    // backstop, not the working exit: every iteration spends at least one
    // unit of `budget` and `canReopenStream` stops at zero, so the
    // condition should never be what ends this loop. It is written anyway
    // because this loop issues network requests, and a loop whose only
    // termination is a helper's return value is one edit away from
    // hammering a provider forever.
    attempts: for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt += 1) {
      try {
        // Opening the stream (connect + status check) happens inside the
        // client's bounded retry, strictly before the first chunk exists.
        const res = await openAiStartStream(this.http, path, body, request, budget);
        // A reopen starts from an empty transcript: whatever the dead
        // attempt accumulated was never yielded and must not be mixed
        // into the fresh one. With the built-in stream consumer nothing
        // can accumulate without also committing, so this is dead weight
        // for it; it is not dead for an injected `streamConsumer`, which
        // may report content on a `done` chunk this loop does not yield.
        accumulated = "";
        accumulatedReasoning = "";
        streamFinal = undefined;
        const stream = this.streamConsumer.consume(res.body, request.signal);
        while (true) {
          const next = await stream.next();
          if (next.done) {
            streamFinal = next.value;
            streamEnded = true;
            break attempts;
          }
          const chunk = next.value;
          if (chunk.delta) accumulated += chunk.delta;
          if (chunk.reasoningDelta) accumulatedReasoning += chunk.reasoningDelta;
          if (!chunk.done) {
            // Set before the yield, deliberately: a caller that throws
            // into this generator (`generator.throw()`, which is how a
            // consumer reports its own failure into a stream it is
            // draining) resumes us *inside* the catch below, with the
            // yield never having returned. Set after the yield, that
            // error would find `committed === false` and replay a
            // completion the caller has already shown part of.
            committed = true;
            yield chunk;
          }
        }
      } catch (err) {
        // Cancellation first, and it throws rather than returning a
        // verdict, because the *shape* of the error decides what the user
        // gets. `classifyFailure` files every `OpenAiHttpError` as
        // `transport` before it ever looks for an abort, and a bare
        // `Error: terminated` from a body that died while the abort was
        // in flight is `transport` too — either one makes `shouldAdvance`
        // report an immediate provider-down signal, so the fallback chain
        // switches links and starts the very completion the user just
        // stopped. `signal.reason` is abort-shaped by construction.
        if (request.signal?.aborted) throw cancellationError(request.signal, err);
        if (!canReopenStream(err, committed, budget)) throw err;
        // No `res.body.cancel()` here, on purpose. The only way to reach
        // this line with a response in hand is `isNetworkError(err)` on
        // an error raised by the body reader — i.e. the stream is already
        // errored, `cancel()` on an errored stream rejects with the
        // stored error, and undici has already destroyed the socket. A
        // cancel call would be a swallowed no-op dressed up as hygiene.
        await openAiRetryBackoff(OPENAI_MAX_ATTEMPTS - budget.remaining, request.signal);
        // `sleep()` resolves on abort instead of rejecting, so without
        // this the loop walks out of the backoff straight into the next
        // open. Today that open throws before it fetches
        // (`runOpenAiWithRetry` checks the signal first) and the check
        // above catches it on the way through, which makes this line
        // redundant *given* that behaviour — no test can tell the two
        // apart, and the mutation sweep confirms it: dropping either
        // check alone keeps the suite green, dropping both fails two
        // tests. It stays because the invariant belongs to this loop:
        // once the caller has cancelled, this loop issues nothing more,
        // whatever the HTTP client decides to do about aborted signals.
        if (request.signal?.aborted) throw cancellationError(request.signal, err);
      }
    }
    if (!streamEnded) {
      // The backstop fired: `canReopenStream` let the loop run past its
      // budget. Returning the empty completion assembled below would look
      // to the user like a model that said nothing, so say what actually
      // happened instead.
      throw new Error(
        "openai stream retry loop ended without a completion — canReopenStream and OPENAI_MAX_ATTEMPTS disagree",
      );
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
 * The error a turn the user cancelled should fail with.
 *
 * `classifyFailure` reads cancellation off the error's *shape*, and the
 * shapes that reach the retry loop when someone presses Esc are not
 * reliably abort-shaped: a body that dies while the abort is in flight
 * arrives as `Error: terminated` (→ `transport`), and an abort noticed
 * inside `runOpenAiWithRetry` arrives as an `OpenAiHttpError` whose
 * `transport` branch is checked *before* the abort branch. Either one
 * makes `shouldAdvance` report an immediate provider-down signal, so the
 * fallback chain switches links and starts the very completion the user
 * just stopped.
 *
 * `signal.reason` is the abort's own error — a `DOMException` named
 * `AbortError` when the aborter supplied nothing — so it classifies as
 * `cancelled`. The original error is the fallback for signal doubles
 * that never populate `reason`.
 */
function cancellationError(signal: AbortSignal, fallback: unknown): unknown {
  const reason: unknown = signal.reason;
  return reason ?? fallback;
}

/**
 * May a failure raised between "2xx headers received" and "first chunk
 * handed to our caller" be recovered by reopening the stream?
 *
 * Cancellation is deliberately NOT one of these guards: the caller checks
 * the signal before asking, because an aborted turn needs a specific
 * error *thrown*, not a boolean returned (see `cancellationError`).
 *
 * The order of the guards that are here is the contract, not a stylistic
 * choice:
 *
 * 1. **Committed.** Once a chunk has been yielded, nothing below matters.
 *    This is a strict reading of "output": a chunk carrying only the
 *    provider's opening `role` delta commits the stream just as a text
 *    delta does. We cannot know what a downstream consumer did with it,
 *    and being wrong here means duplicating a user's reply. Reasoning
 *    deltas are output for the same reason — the TUI renders them live.
 *
 *    What this does NOT cover is a completion that streamed nothing but
 *    tool-call arguments: `createOpenAiStreamConsumer` yields on a
 *    `function.arguments` delta only once the accumulated arguments
 *    contain reply text, so a `{"path":"a.txt"` in flight leaves
 *    `committed` false and such a stream IS reopened. That is safe — no
 *    text reached the user, and tools are dispatched only after the
 *    completion returns — and it is what the reporter's case wants, since
 *    a tool call whose arguments never finished streaming is not a usable
 *    turn. It is spelled out because "any chunk we yielded" and "any byte
 *    the provider sent" are not the same line.
 * 2. **`OpenAiHttpError`.** The failure came from *opening* the stream,
 *    inside `runOpenAiWithRetry`, which has already applied this client's
 *    retry policy to it. Reopening here would quietly replace that policy
 *    with a looser one, because `isNetworkError` says yes to failures
 *    `isRetryableOpenAiError` deliberately says no to: our own request
 *    timeout, and any non-retryable status whose body preview happens to
 *    mention a socket. The shared budget makes this cheap rather than
 *    catastrophic now — a *retryable* open failure has already drained
 *    the budget, so guard 4 would stop it anyway — but a non-retryable
 *    one still has budget left, and re-deciding a call the HTTP client
 *    already made is how a deterministic failure turns into three
 *    requests and a delayed, actionable message.
 * 3. **Shape.** Anything that is not a recognisable transport death — a
 *    bug in a stream consumer, a parse error — is a real error. Replaying
 *    it would just hide it behind three identical failures.
 * 4. **Budget.** One streaming completion gets `OPENAI_MAX_ATTEMPTS`
 *    requests in total, shared with the opens: the same counter is passed
 *    into `openAiStartStream`, so opens and reopens add up instead of
 *    multiplying.
 */
function canReopenStream(
  err: unknown,
  committed: boolean,
  budget: OpenAiAttemptBudget,
): boolean {
  if (committed) return false;
  if (err instanceof OpenAiHttpError) return false;
  if (!isNetworkError(err)) return false;
  return budget.remaining > 0;
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
