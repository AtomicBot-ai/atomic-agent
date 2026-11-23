import { CHATGPT_FALLBACK_DEFAULT_MODEL } from "./chatgpt-default-model.js";
import type {
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  OpenAiToolCall,
  StreamChunk,
} from "../completion-types.js";
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderHealthResult,
  VisionRequest,
  VisionResult,
} from "../llm-provider.js";
import { VisionUnsupportedError } from "../llm-provider.js";
import { OpenAiHttpError } from "../openai/openai-http.js";
import { openAiToolCallAdapter } from "../openai/openai-tool-call-adapter.js";
import { parseRateLimitHeaders, type RateLimitWindow } from "../rate-limits.js";
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_ORIGINATOR,
  chatgptAccountId,
} from "./chatgpt-codex.js";
import {
  buildChatgptResponsesBody,
  parseChatgptEvent,
  readSseEvents,
} from "./chatgpt-responses.js";
import {
  ChatgptSignInRequiredError,
  OAuthFlowError,
  SignInRequiredError,
} from "./oauth-errors.js";
import type { OAuthTokens, TokenStore } from "./oauth-types.js";
import type { TokenRefresher } from "./token-refresh.js";

/**
 * EXPERIMENTAL (ATO-1448 / ATO-1453): a ChatGPT plan as an LLM backend
 * without the Codex CLI. Signs requests with the tokens `atag login
 * chatgpt` stored (`auth/chatgpt.json`) and sends them, as the Codex CLI
 * does, to the ChatGPT backend's Responses endpoint with
 * `Authorization: Bearer` and `chatgpt-account-id`.
 *
 * A 401 refreshes the token once and retries; a second 401, or a
 * refresh the server refuses, ends in `ChatgptSignInRequiredError`
 * ("sign in again"), never a loop. Codex does the same: one
 * `refresh_after_unauthorized` per request (codex-rs/codex-api/src/auth.rs).
 *
 * The `subscription-cli` kind (Codex CLI) stays the primary path; this
 * kind is only used when an entry asks for it.
 */

export const SUBSCRIPTION_OAUTH_DISPLAY_NAME = "ChatGPT subscription (sign in, experimental)";
/**
 * The model used when an entry names none: Codex's bundled default
 * (`chatgpt-default-model.ts`). `atag login chatgpt` writes Codex's live
 * default into the entry instead, so this is only the offline fallback.
 */
export const CHATGPT_DEFAULT_MODEL = CHATGPT_FALLBACK_DEFAULT_MODEL;
/**
 * The smallest `context_window` among the picker-visible models of
 * Codex's catalog (codex-rs/models-manager/models.json), so the window
 * stays safe whichever model Codex currently defaults to.
 */
const CHATGPT_CONTEXT_WINDOW = 272_000;
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_ERROR_BODY = 2_000;

/** The fetch surface the provider needs; `globalThis.fetch` fits. */
export type ResponsesFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface SubscriptionOAuthProviderOptions {
  id: string;
  store: TokenStore;
  refresher: TokenRefresher;
  model?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: ResponsesFetch;
  now?: () => number;
}

export class SubscriptionOAuthProvider implements LlmProvider {
  readonly id: string;
  readonly name = SUBSCRIPTION_OAUTH_DISPLAY_NAME;
  readonly capabilities: ProviderCapabilities;
  /** Tools go out as Responses function tools built from the OpenAI shapes. */
  readonly toolCallAdapter = openAiToolCallAdapter;
  /** Streaming is read here end to end. */
  readonly streamConsumer = null;
  readonly chatModelId: string;

  private readonly store: TokenStore;
  private readonly refresher: TokenRefresher;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ResponsesFetch;
  private readonly now: () => number;
  private rateLimits: RateLimitWindow[] = [];

  constructor(options: SubscriptionOAuthProviderOptions) {
    this.id = options.id;
    this.store = options.store;
    this.refresher = options.refresher;
    this.chatModelId = options.model && options.model.length > 0 ? options.model : CHATGPT_DEFAULT_MODEL;
    this.url = `${(options.baseUrl ?? CHATGPT_CODEX_BASE_URL).replace(/\/+$/, "")}/responses`;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ResponsesFetch);
    this.now = options.now ?? Date.now;
    this.capabilities = {
      vision: false,
      visionSource: "config-disabled",
      toolTransport: "native_tools",
      contextWindow: CHATGPT_CONTEXT_WINDOW,
      supportsParallelTools: true,
      supportsSlotAffinity: false,
      supportsPromptCache: true,
      reasoningFormat: "none",
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const stream = this.completeStream(request);
    for (;;) {
      const next = await stream.next();
      if (next.done) return next.value;
    }
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const started = this.now();
    const body = JSON.stringify(
      buildChatgptResponsesBody(request, { model: this.chatModelId }),
    );
    const timeout = AbortSignal.timeout(request.requestTimeoutMs ?? this.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const response = await this.open(body, request.sessionId, signal);
    const headerLimits = parseRateLimitHeaders(response.headers, this.now());
    if (headerLimits.length > 0) this.rateLimits = headerLimits;
    if (!response.body) {
      throw new OpenAiHttpError("ChatGPT answered with an empty body", response.status, this.url, false, null, this.id);
    }

    let content = "";
    let reasoning = "";
    let messageText = "";
    const toolCalls: OpenAiToolCall[] = [];
    let generationId: string | undefined;
    let usage: CompletionUsage | undefined;
    let modelId: string | null = this.chatModelId;
    let incompleteReason: string | undefined;
    let finished = false;

    for await (const event of readSseEvents(response.body)) {
      const step = parseChatgptEvent(event.data, this.now());
      switch (step.kind) {
        case "text":
          content += step.delta;
          yield { delta: step.delta, reasoningDelta: "", done: false };
          break;
        case "reasoning":
          reasoning += step.delta;
          yield { delta: "", reasoningDelta: step.delta, done: false };
          break;
        case "message_text":
          messageText += step.text;
          break;
        case "tool_call":
          toolCalls.push(step.call);
          break;
        case "created":
          generationId = step.id;
          break;
        case "rate_limits":
          if (step.windows.length > 0) this.rateLimits = step.windows;
          break;
        case "done":
          finished = true;
          incompleteReason = step.incompleteReason;
          usage = step.usage;
          if (step.model) modelId = step.model;
          break;
        case "failure":
          throw new OpenAiHttpError(
            `ChatGPT reported an error in its reply: ${step.failure.message}`,
            step.failure.code === "rate_limit_exceeded" || step.failure.code === "usage_limit_reached" ? 429 : 500,
            this.url,
            false,
            null,
            this.id,
            undefined,
            {
              streamError: step.failure.message,
              ...(generationId ? { generationId } : {}),
            },
          );
        case "ignore":
          break;
      }
      if (finished) break;
    }
    if (!finished) {
      throw new OpenAiHttpError(
        "ChatGPT closed the stream before the reply was complete",
        null,
        this.url,
        false,
        null,
        this.id,
        undefined,
        { streamError: "stream ended early", ...(generationId ? { generationId } : {}) },
      );
    }
    // A reply sent whole, without deltas, still counts.
    if (content.length === 0 && messageText.length > 0) {
      content = messageText;
      yield { delta: messageText, reasoningDelta: "", done: false };
    }
    const truncated = incompleteReason === "max_output_tokens";
    yield { delta: "", reasoningDelta: "", done: true };
    const elapsed = this.now() - started;
    return {
      content,
      reasoningContent: reasoning,
      stop: !truncated,
      truncated,
      timing: {
        promptMs: 0,
        predictedMs: elapsed,
        promptTokens: usage?.promptTokens ?? 0,
        predictedTokens: usage?.completionTokens ?? 0,
      },
      cacheHitTokens: usage?.cachedTokens ?? 0,
      slotId: -1,
      modelId,
      ...(usage ? { usage } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      finishReason: truncated ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop",
      sentMaxTokens: null,
      ...(this.rateLimits.length > 0 ? { rateLimits: [...this.rateLimits] } : {}),
      ...(generationId ? { generationId } : {}),
    };
  }

  /**
   * POST with the stored token; on a 401 refresh once and retry once.
   * Returns the open 2xx response; anything else is thrown typed.
   */
  private async open(
    body: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ResponsesFetch>>> {
    let tokens = await this.tokens(() => this.refresher.getValidTokens(signal));
    for (let attempt = 0; ; attempt++) {
      const response = await this.post(body, tokens, sessionId, signal);
      if (response.ok) return response;
      if (response.status === 401 && attempt === 0) {
        await drain(response);
        tokens = await this.tokens(() => this.refresher.refresh(signal));
        continue;
      }
      if (response.status === 401) {
        await drain(response);
        throw new ChatgptSignInRequiredError("unauthorized_after_refresh");
      }
      throw await this.httpError(response);
    }
  }

  private async post(
    body: string,
    tokens: OAuthTokens,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ResponsesFetch>>> {
    const accountId = chatgptAccountId(tokens);
    if (accountId === null) throw new ChatgptSignInRequiredError("no_account_id");
    // Header set per pi's `buildSSEHeaders` and Codex's request headers.
    const headers: Record<string, string> = {
      authorization: `Bearer ${tokens.accessToken}`,
      [CHATGPT_ACCOUNT_ID_HEADER]: accountId,
      originator: CHATGPT_ORIGINATOR,
      "OpenAI-Beta": "responses=experimental",
      accept: "text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "session-id": sessionId } : {}),
    };
    try {
      return await this.fetchImpl(this.url, { method: "POST", headers, body, signal });
    } catch (err) {
      // The cause is kept off the message: it can carry the request.
      const timedOut = signal.aborted && (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
      throw new OpenAiHttpError(
        timedOut ? "ChatGPT took too long to answer" : "Cannot reach ChatGPT",
        null,
        this.url,
        timedOut,
        null,
        this.id,
        (err as { code?: string } | null)?.code,
        { cause: err },
      );
    }
  }

  /** Token reads and refreshes, with sign-in failures given one remedy. */
  private async tokens(read: () => Promise<OAuthTokens>): Promise<OAuthTokens> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof SignInRequiredError) {
        throw new ChatgptSignInRequiredError(err.reason, { cause: err });
      }
      // Codex treats a 401 from the token endpoint as a refused refresh
      // token, whatever the body's `error` says (manager.rs
      // `request_chatgpt_token_refresh`).
      if (err instanceof OAuthFlowError && err.status === 401) {
        throw new ChatgptSignInRequiredError("refresh_unauthorized", { cause: err });
      }
      if (err instanceof OAuthFlowError) {
        throw new OpenAiHttpError(
          `Could not renew the ChatGPT sign-in (${err.code})`,
          err.status ?? null,
          "https://auth.openai.com/oauth/token",
          false,
          null,
          this.id,
        );
      }
      throw err;
    }
  }

  private async httpError(response: Awaited<ReturnType<ResponsesFetch>>): Promise<OpenAiHttpError> {
    let text = "";
    try {
      text = (await response.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      text = "";
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const limits = parseRateLimitHeaders(response.headers, this.now());
    if (limits.length > 0) this.rateLimits = limits;
    return new OpenAiHttpError(
      `ChatGPT answered ${response.status}${text ? `: ${errorWords(text)}` : ""}`,
      response.status,
      this.url,
      false,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
      this.id,
    );
  }

  async describeImage(_request: VisionRequest): Promise<VisionResult> {
    throw new VisionUnsupportedError(this.id);
  }

  /**
   * Signed in or not, read from the token file. Nothing is sent: a probe
   * request would spend the plan, the same reason the CLI kind only runs
   * `--version`.
   */
  async health(): Promise<ProviderHealthResult> {
    const started = this.now();
    try {
      const tokens = await this.store.load();
      const ok = tokens !== null && chatgptAccountId(tokens) !== null;
      return {
        reachable: ok,
        status: null,
        error: ok ? null : "not signed in: run `atag login chatgpt`",
        latencyMs: this.now() - started,
      };
    } catch (err) {
      return {
        reachable: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: this.now() - started,
      };
    }
  }

  async close(): Promise<void> {
    // Stateless; the token file outlives the provider.
  }

  async listModels(): Promise<readonly string[]> {
    return [this.chatModelId];
  }
}

/** The backend's `detail` / `error.message`, else the raw text, on one line. */
function errorWords(text: string): string {
  try {
    const parsed = JSON.parse(text) as { detail?: unknown; error?: { message?: unknown } | unknown };
    if (typeof parsed.detail === "string") return parsed.detail.slice(0, 300);
    const message = (parsed.error as { message?: unknown } | undefined)?.message;
    if (typeof message === "string") return message.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, " ").slice(0, 300);
}

async function drain(response: { text(): Promise<string> }): Promise<void> {
  try {
    await response.text();
  } catch {
    // nothing to release
  }
}
