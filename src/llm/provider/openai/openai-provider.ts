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
  openAiStartStream,
  type OpenAiHttpDeps,
} from "./openai-http.js";
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
    this.http = {
      baseUrl: normalizeOpenAiBaseUrl(options.baseUrl),
      apiKey: options.apiKey,
      extraHeaders: options.headers ?? {},
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      fetchImpl: options.fetchImpl ?? fetch,
      label: options.id,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = buildOpenAiChatBody(request, this.defaultChatModel, false);
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
    const body = buildOpenAiChatBody(request, this.defaultChatModel, true);
    // Opening the stream (connect + status check) happens inside the
    // client's bounded retry, strictly before the first chunk exists.
    // From here on the stream is live and failures are terminal.
    const res = await openAiStartStream(
      this.http,
      `${this.apiPathPrefix}/chat/completions`,
      body,
      request,
    );
    let accumulated = "";
    let accumulatedReasoning = "";
    let streamFinal: StreamFinalResult | void;
    const stream = this.streamConsumer.consume(res.body, request.signal);
    while (true) {
      const next = await stream.next();
      if (next.done) {
        streamFinal = next.value;
        break;
      }
      const chunk = next.value;
      if (chunk.delta) accumulated += chunk.delta;
      if (chunk.reasoningDelta) accumulatedReasoning += chunk.reasoningDelta;
      if (!chunk.done) {
        yield chunk;
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
    if (this.taggedToolCompatibility === "qwen") {
      // Buffer-then-adapt: the tagged `<tool_call>` payload may be split
      // across deltas, so adapt only the fully-buffered message. Text and
      // reasoning deltas were already yielded above for live UX; the adapt
      // seam just rewrites the final result (content → tool_calls).
      return adaptQwenCompletionResult(final, request);
    }
    return final;
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
