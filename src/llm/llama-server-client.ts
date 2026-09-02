import { getConfig } from "../config/index.js";
import { llamaEndpointUrl } from "./llama-endpoint-url.js";
import { readErrnoCode } from "./errno-code.js";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
} from "./provider/completion-types.js";

export type {
  CompletionRequest,
  CompletionResult,
  CompletionTiming,
  StreamChunk,
} from "./provider/completion-types.js";

/**
 * Eval/ops-only sampling overrides read from the environment at load time.
 * Production defaults are unchanged (temperature 0.2 / top_p 0.95 / top_k 40,
 * no seed); these take effect only when the matching env var is set, and an
 * explicit per-request value still wins over the env. The benchmark harness
 * sets these to pin greedy, reproducible decoding (temperature 0 + fixed
 * seed) so a prompt-version comparison is not confounded by sampling noise.
 */
function parseFloatEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseIntEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

const ENV_TEMPERATURE = parseFloatEnv(process.env.ATOMIC_AGENT_LLAMA_TEMPERATURE);
const ENV_TOP_P = parseFloatEnv(process.env.ATOMIC_AGENT_LLAMA_TOP_P);
const ENV_TOP_K = parseIntEnv(process.env.ATOMIC_AGENT_LLAMA_TOP_K);
const ENV_SEED = parseIntEnv(process.env.ATOMIC_AGENT_LLAMA_SEED);

/**
 * Which of our own deadlines fired.
 *
 *  - `total` — the whole request was given `requestTimeoutMs` and never
 *    produced a response. The only signal a unary request has.
 *  - `first-token` — a *stream*'s headers arrived and then nothing did,
 *    for `requestTimeoutMs`. llama.cpp answers with headers immediately
 *    and only then evaluates the prompt, so this usually means the
 *    prompt eval is still running, **not** that the server is broken.
 *  - `idle` — a *stream* that had already sent at least one byte went
 *    `requestTimeoutMs` without sending another. A healthy generation
 *    refreshes this budget on every chunk, so it means the server went
 *    quiet mid-reply, not that the answer was long.
 *  - `stream-total` — a stream kept sending but never finished within
 *    `streamTotalTimeoutMs`. The backstop that keeps a wedged or
 *    hostile server from pinning a slot forever by dribbling one byte
 *    just under the idle budget.
 */
export type LlamaTimeoutKind =
  | "total"
  | "first-token"
  | "idle"
  | "stream-total";

export class LlamaServerError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly url: string,
    /**
     * True when *our own* `requestTimeoutMs` controller fired rather than
     * the transport failing — for any of our deadlines (see
     * `LlamaTimeoutKind`). Both surface as `status === null`, but a
     * timeout is a "the model is slower than the budget" signal, not a
     * transient blip — replaying it just burns another full timeout of
     * GPU time (3 attempts x 300s = 15 silent minutes). See
     * `isRetryableLlamaError`.
     *
     * An idle stall stays flagged here on purpose. It is tempting to read
     * "the server went quiet" as harder evidence of a dead provider than
     * "the server is slow", and so let `shouldAdvance` fall over on the
     * first occurrence — but llama.cpp streams response headers before it
     * evaluates the prompt, so a long CPU prompt-eval is genuinely silent
     * for minutes while nothing is wrong. Keeping the flag leaves the
     * fallover behaviour exactly where it was: advance on the
     * consecutive-failure threshold, never immediately.
     */
    public readonly timedOut = false,
    /**
     * Errno of the underlying failure (`ECONNREFUSED`, `ECONNRESET`,
     * `ETIMEDOUT`, `UND_ERR_*`, …) when the transport left one behind.
     * This is the difference between "the daemon was never started" and
     * "the daemon died under us" — two problems with opposite fixes
     * that both surface as `status === null`.
     */
    public readonly code: string | undefined = undefined,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "LlamaServerError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Cap on how much of a server error body we fold into the message. */
const LLAMA_ERROR_DETAIL_MAX_LEN = 300;

/**
 * Pull a human-readable detail out of a llama-server error response
 * body. llama.cpp emits either `{"error":{"message":"..."}}`,
 * `{"error":"..."}`, or plain text. Returns a trimmed, length-capped
 * string (empty when nothing useful is present). Pure — never throws.
 */
export function extractLlamaErrorDetail(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) return "";
  let detail = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object") {
      const errField = (parsed as Record<string, unknown>)["error"];
      if (typeof errField === "string") {
        detail = errField;
      } else if (errField && typeof errField === "object") {
        const msg = (errField as Record<string, unknown>)["message"];
        if (typeof msg === "string") detail = msg;
      } else {
        const topMsg = (parsed as Record<string, unknown>)["message"];
        if (typeof topMsg === "string") detail = topMsg;
      }
    }
  } catch {
    // Not JSON — fall back to the raw text.
  }
  detail = detail.trim().replace(/\s+/g, " ");
  if (detail.length > LLAMA_ERROR_DETAIL_MAX_LEN) {
    detail = `${detail.slice(0, LLAMA_ERROR_DETAIL_MAX_LEN - 1)}…`;
  }
  return detail;
}

/**
 * Build a `LlamaServerError` for a non-OK HTTP response, folding the
 * server's error body into the message so callers surface the actual
 * cause (e.g. "request (5369 tokens) exceeds the available context size
 * (4096 tokens)") instead of a bare status code. Reading the body is
 * best-effort — a read failure degrades to the status-only message.
 */
async function buildHttpError(
  response: Response,
  url: string,
): Promise<LlamaServerError> {
  let detail = "";
  try {
    detail = extractLlamaErrorDetail(await response.text());
  } catch {
    // Body already consumed / unreadable — keep the status-only message.
  }
  const base = `llama-server returned http ${response.status}`;
  return new LlamaServerError(
    detail ? `${base}: ${detail}` : base,
    response.status,
    url,
  );
}

export interface LlamaServerClientOptions {
  baseUrl?: string;
  apiKey?: string | null;
  requestTimeoutMs?: number;
  /**
   * Overrides `config.localModels.streamTotalTimeoutMs`, the absolute
   * cap on a single streaming response. Streaming only — a unary
   * request is already bounded by `requestTimeoutMs`.
   */
  streamTotalTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Overrides the retry budget for `complete()` and the initial fetch
   * of `completeStream()`. When omitted, the client reads
   * `config.localModels.completionRetries` on each request.
   */
  completionRetries?: number;
  completionRetryBackoffMs?: number;
  /**
   * Injectable sleep used during backoff. Tests pass a spy that returns
   * immediately so retry logic is exercised without real time.
   */
  sleep?: (ms: number) => Promise<void>;
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
  private readonly streamTotalTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly completionRetriesOverride: number | undefined;
  private readonly completionRetryBackoffMsOverride: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LlamaServerClientOptions = {}) {
    const config = getConfig();
    this.baseUrlOverride = options.baseUrl;
    this.apiKey = options.apiKey ?? config.localModels.apiKey;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? config.localModels.requestTimeoutMs;
    this.streamTotalTimeoutMs =
      options.streamTotalTimeoutMs ?? config.localModels.streamTotalTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.completionRetriesOverride = options.completionRetries;
    this.completionRetryBackoffMsOverride = options.completionRetryBackoffMs;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async fetchProps(): Promise<LlamaServerProps> {
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.localModels.url;
    const url = llamaEndpointUrl(base, "/props");
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
        throw await buildHttpError(response, url);
      }
      return (await response.json()) as LlamaServerProps;
    } catch (err) {
      if (err instanceof LlamaServerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlamaServerError(message, null, url, false, readErrnoCode(err), {
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { url, headers, body } = this.prepareRequest(request, false);
    return this.runWithRetry(
      url,
      async () => {
        const { controller, cleanup, timedOut } = this.createRequestController(
          request.signal,
        );
        try {
          const response = await this.fetchImpl(url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          });
          if (!response.ok) {
            throw await buildHttpError(response, url);
          }
          const json = (await response.json()) as Record<string, unknown>;
          return normaliseCompletionResponse(json);
        } catch (err) {
          throw this.wrapTransportError(err, url, timedOut());
        } finally {
          cleanup();
        }
      },
      request.signal,
    );
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const { url, headers, body } = this.prepareRequest(request, true);
    // Retry only the initial fetch. Once the body starts streaming we
    // can't safely replay — partial tokens have already been delivered
    // to the caller and the model has been charged for them server-side.
    let opened: {
      response: Response;
      controller: AbortController;
      cleanup: () => void;
      timedOut: () => LlamaTimeoutKind | null;
      keepAlive: (next: Exclude<LlamaTimeoutKind, "total">) => void;
      startStreamDeadline: () => void;
    };
    try {
      opened = await this.runWithRetry(
        url,
        async () => {
          const { controller, cleanup, timedOut, keepAlive, startStreamDeadline } =
            this.createRequestController(request.signal);
          try {
            const response = await this.fetchImpl(url, {
              method: "POST",
              headers,
              body,
              signal: controller.signal,
            });
            if (!response.ok || !response.body) {
              throw await buildHttpError(response, url);
            }
            return {
              response,
              controller,
              cleanup,
              timedOut,
              keepAlive,
              startStreamDeadline,
            };
          } catch (err) {
            cleanup();
            throw this.wrapTransportError(err, url, timedOut());
          }
        },
        request.signal,
      );
    } catch (err) {
      if (err instanceof LlamaServerError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new LlamaServerError(message, null, url, false, readErrnoCode(err), {
        cause: err,
      });
    }
    const { response, cleanup, timedOut, keepAlive, startStreamDeadline } =
      opened;
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
      if (!response.body) {
        throw new LlamaServerError(
          "llama-server returned no streaming body",
          response.status,
          url,
        );
      }
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
      // Headers are in; from here the deadline bounds *silence*, not the
      // length of the answer. Re-arming once here also hands the body a
      // full budget rather than whatever the connect phase left over —
      // llama.cpp answers with headers immediately and only then evaluates
      // the prompt, so the first token can legitimately be minutes away.
      // Until a byte actually arrives the deadline reports `first-token`:
      // a silence *before* the reply starts is most likely a long prompt
      // eval, and telling that user their server "stopped responding" is
      // the same bad advice this change exists to remove.
      keepAlive("first-token");
      // And an idle budget alone is not an upper bound — arm the absolute
      // cap so a server dribbling one byte per (budget - 1)ms cannot pin
      // this slot, session and process forever.
      startStreamDeadline();
      let buffer = "";
      let accumulated = "";
      let accumulatedReasoning = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // A byte arrived: the server is alive, so start the clock over —
        // and from now on a silence really is a mid-reply stall.
        // Deliberately not called on `done` — that breaks straight out of
        // the loop into `finally { cleanup() }` with nothing awaited in
        // between, so there is no window left for the timer to fire.
        keepAlive("idle");
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
      throw this.wrapTransportError(err, url, timedOut());
    } finally {
      cleanup();
    }
  }

  /**
   * Build an `AbortController` for a single completion request that
   * fires on **either** the per-request timeout **or** the caller's
   * external abort signal (Ctrl+C in the TUI, `runTurn({ signal })`).
   * The returned `cleanup` clears the timeout and detaches the external
   * listener — call it in `finally` so a long-lived stream does not leak
   * the listener.
   *
   * The deadline starts as a **total** budget, which is all a unary
   * request can be given: it has exactly one event to wait for. A
   * streaming caller converts it into an **idle** budget by calling
   * `keepAlive()` on every byte it receives — see `completeStream`.
   * Without that, `requestTimeoutMs` was a wall-clock cap on the whole
   * generation and killed healthy long answers at exactly the budget,
   * discarding every token already produced.
   *
   * An idle budget alone is not an upper bound: a server emitting one
   * byte just under it streams forever. `startStreamDeadline()` arms the
   * second, never-refreshed timer that puts a ceiling back on — see
   * `streamTotalTimeoutMs`. So a live stream holds two pending timers,
   * and `cleanup` clears both.
   */
  private createRequestController(externalSignal?: AbortSignal): {
    controller: AbortController;
    cleanup: () => void;
    /**
     * Which of our own deadlines fired the abort, or `null` when the
     * abort came from the caller / nothing fired at all.
     */
    timedOut: () => LlamaTimeoutKind | null;
    /**
     * Restart the deadline and record what a subsequent expiry means:
     * `first-token` once headers are in, `idle` once the body has
     * actually produced something. A no-op once the request is already
     * aborted or a deadline has already fired, so a byte that was still
     * in the decode pipe when the abort landed cannot re-arm the timer
     * or rewrite which deadline gets reported.
     */
    keepAlive: (next: Exclude<LlamaTimeoutKind, "total">) => void;
    /**
     * Arm the absolute streaming cap. Idempotent, and a no-op once the
     * request is aborted. Called once, at response headers, so the cap
     * measures the body and not the connect phase.
     */
    startStreamDeadline: () => void;
  } {
    const controller = new AbortController();
    let expired: LlamaTimeoutKind | null = null;
    let kind: LlamaTimeoutKind = "total";
    const arm = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        expired = kind;
        controller.abort();
      }, this.requestTimeoutMs);
    let timer = arm();
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = (): LlamaTimeoutKind | null => expired;
    const keepAlive = (next: Exclude<LlamaTimeoutKind, "total">): void => {
      if (expired !== null || controller.signal.aborted) return;
      clearTimeout(timer);
      kind = next;
      timer = arm();
    };
    const startStreamDeadline = (): void => {
      if (expired !== null || controller.signal.aborted) return;
      if (streamTimer !== null) return;
      streamTimer = setTimeout(() => {
        expired = "stream-total";
        controller.abort();
      }, this.streamTotalTimeoutMs);
    };
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (streamTimer !== null) clearTimeout(streamTimer);
    };
    if (!externalSignal) {
      return {
        controller,
        cleanup: clearTimers,
        timedOut,
        keepAlive,
        startStreamDeadline,
      };
    }
    if (externalSignal.aborted) {
      controller.abort();
      return {
        controller,
        cleanup: clearTimers,
        timedOut,
        keepAlive,
        startStreamDeadline,
      };
    }
    const onAbort = (): void => controller.abort();
    externalSignal.addEventListener("abort", onAbort, { once: true });
    return {
      controller,
      timedOut,
      keepAlive,
      startStreamDeadline,
      cleanup: () => {
        clearTimers();
        externalSignal.removeEventListener("abort", onAbort);
      },
    };
  }

  /**
   * Normalise a caught transport failure into a `LlamaServerError`,
   * preserving whether it was our own request-timeout so the retry policy
   * can refuse to replay it. Pass-through for errors already of that type.
   */
  private wrapTransportError(
    err: unknown,
    url: string,
    timedOut: LlamaTimeoutKind | null,
  ): LlamaServerError {
    if (err instanceof LlamaServerError) return err;
    // Each deadline needs its own advice. "Lower completionMaxTokens"
    // is meaningless when the server sent nothing at all — the answer
    // was not too long, it never came — and "the server stopped
    // responding" is wrong when it never started, which for llama.cpp
    // is the ordinary look of a long prompt eval.
    if (timedOut === "first-token") {
      return new LlamaServerError(
        `llama-server accepted the request but sent no first token within ${this.requestTimeoutMs}ms — ` +
          `it may still be evaluating the prompt; raise localModels.requestTimeoutMs, ` +
          `or shorten the prompt/context if it is too large for this machine to evaluate in time`,
        null,
        url,
        true,
        undefined,
        { cause: err },
      );
    }
    if (timedOut === "stream-total") {
      return new LlamaServerError(
        `llama-server streamed for longer than streamTotalTimeoutMs (${this.streamTotalTimeoutMs}ms) without finishing — ` +
          `data kept arriving, so this is the absolute cap on one streaming reply, not a stall; ` +
          `raise localModels.streamTotalTimeoutMs (ATOMIC_AGENT_LLAMA_STREAM_TOTAL_TIMEOUT_MS) ` +
          `or lower completionMaxTokens`,
        null,
        url,
        true,
        undefined,
        { cause: err },
      );
    }
    if (timedOut === "idle") {
      return new LlamaServerError(
        `llama-server sent no data for ${this.requestTimeoutMs}ms mid-stream — ` +
          `the server stopped responding after starting the reply; check that ` +
          `llama-server is still running, or raise localModels.requestTimeoutMs`,
        null,
        url,
        true,
        undefined,
        { cause: err },
      );
    }
    if (timedOut === "total") {
      return new LlamaServerError(
        `llama-server request exceeded requestTimeoutMs (${this.requestTimeoutMs}ms) — ` +
          `raise localModels.requestTimeoutMs or lower completionMaxTokens`,
        null,
        url,
        true,
        undefined,
        { cause: err },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    // Keep the errno and the original error. Rebuilding the failure
    // without them is what left the biggest bucket in error reporting
    // undiagnosable: ~1,900 events that say "the network failed" and
    // nothing about how.
    return new LlamaServerError(message, null, url, false, readErrnoCode(err), {
      cause: err,
    });
  }

  private prepareRequest(
    request: CompletionRequest,
    stream: boolean,
  ): { url: string; headers: Record<string, string>; body: string } {
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.localModels.url;
    const url = llamaEndpointUrl(base, config.localModels.completionPath);
    const headers = this.buildHeaders(stream);
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      stream,
      cache_prompt: request.cachePrompt ?? true,
      temperature: request.temperature ?? ENV_TEMPERATURE ?? 0.2,
      top_p: request.topP ?? ENV_TOP_P ?? 0.95,
      top_k: request.topK ?? ENV_TOP_K ?? 40,
      n_predict: request.maxTokens ?? config.localModels.completionMaxTokens,
      repeat_penalty: request.repeatPenalty ?? 1.1,
      repeat_last_n: request.repeatLastN ?? 256,
    };
    if (request.grammar) payload.grammar = request.grammar;
    if (request.stop) payload.stop = request.stop;
    const resolvedSeed =
      typeof request.seed === "number" ? request.seed : ENV_SEED;
    if (typeof resolvedSeed === "number") payload.seed = resolvedSeed;
    if (typeof request.slotId === "number") {
      payload.slot_id = request.slotId;
      payload.id_slot = request.slotId;
    }
    if (request.imageData && request.imageData.length > 0) {
      payload.image_data = request.imageData.map((img) => ({
        id: img.id,
        data: img.data,
      }));
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

  private resolveRetryParams(): { maxAttempts: number; backoffMs: number } {
    const config = getConfig();
    const maxAttempts = Math.max(
      1,
      this.completionRetriesOverride ?? config.localModels.completionRetries,
    );
    const backoffMs = Math.max(
      0,
      this.completionRetryBackoffMsOverride ??
        config.localModels.completionRetryBackoffMs,
    );
    return { maxAttempts, backoffMs };
  }

  /**
   * Run `attempt` up to `maxAttempts` times, retrying only on transport
   * failures — network errors surface as `LlamaServerError` with
   * `status === null`, and 5xx responses come through with `status >= 500`.
   * Grammar/validation 4xx errors and abort signals short-circuit.
   */
  private async runWithRetry<T>(
    url: string,
    attempt: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const { maxAttempts, backoffMs } = this.resolveRetryParams();
    let lastError: unknown;
    for (let i = 1; i <= maxAttempts; i += 1) {
      if (signal?.aborted) {
        throw new LlamaServerError("completion aborted by caller", null, url);
      }
      try {
        return await attempt();
      } catch (err) {
        lastError = err;
        // A caller-triggered abort is never retryable — the AbortError
        // surfaces as a `status === null` LlamaServerError which would
        // otherwise be treated as a transient network failure.
        if (signal?.aborted) throw err;
        if (!isRetryableLlamaError(err) || i >= maxAttempts) throw err;
        await this.sleep(computeBackoffMs(backoffMs, i));
      }
    }
    // Unreachable: loop either returns or throws.
    throw lastError instanceof Error
      ? lastError
      : new LlamaServerError(String(lastError), null, url);
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

/**
 * Decide whether a caught completion error is worth retrying. The
 * policy deliberately narrow: only transport-layer failures (network
 * hiccups, HTTP 5xx from llama-server) qualify. Grammar/validation
 * errors (4xx) and user-triggered aborts must propagate immediately.
 */
function isRetryableLlamaError(err: unknown): boolean {
  if (!(err instanceof LlamaServerError)) return false;
  // Our own request-timeout, not a transport failure. Replaying it costs
  // another full `requestTimeoutMs` of GPU time and cannot succeed if the
  // model simply needs longer than the budget.
  if (err.timedOut) return false;
  if (err.status === null) return true;
  if (err.status >= 500 && err.status < 600) return true;
  return false;
}

/**
 * Exponential backoff with a ±20% jitter. Keeps the retry storm bounded
 * so a degraded llama-server has a chance to recover between attempts.
 */
function computeBackoffMs(baseMs: number, attemptNumber: number): number {
  if (baseMs <= 0) return 0;
  const exp = baseMs * Math.pow(2, attemptNumber - 1);
  const jitter = exp * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.round(exp + jitter));
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
