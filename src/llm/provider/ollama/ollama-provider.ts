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
} from "../completion-types.js";
import type { ToolCallAdapter } from "../adapters/tool-call-adapter.js";
import type { StreamConsumer } from "../adapters/stream-consumer.js";
import { openAiToolCallAdapter } from "../openai/openai-tool-call-adapter.js";
import {
  buildOpenAiHeaders,
  openAiGetJson,
  openAiPostJson,
  openAiStartStream,
  type OpenAiHttpDeps,
} from "../openai/openai-http.js";
import { buildOllamaChatBody } from "./ollama-build-body.js";
import {
  completionFromOllamaChat,
  type OllamaChatChunk,
} from "./ollama-normalise-response.js";
import { consumeOllamaNdjson } from "./ollama-ndjson.js";

export const DEFAULT_OLLAMA_BASE = "http://localhost:11434";
export const OLLAMA_DEFAULT_CHAT_MODEL = "qwen3.6";

/**
 * Context window this provider asks Ollama for, capped by the model's
 * trained maximum (looked up lazily via `/api/show`). Ollama's own
 * default is sized by free VRAM and can land at 4k, which an agent
 * request overflows on the system prompt alone — the model then
 * silently forgets earlier turns. Asking for 32k trades some speed on
 * small machines for a working agent; the OpenAI-compatible endpoint
 * offers no way to ask at all, which is the reason this native
 * provider exists.
 */
export const OLLAMA_AGENT_NUM_CTX = 32_768;

export interface OllamaProviderOptions {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  defaultChatModel?: string;
  headers?: Record<string, string>;
  supportsVision?: boolean;
  supportsParallelTools?: boolean;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Native Ollama provider speaking `/api/chat`, `/api/tags`, and
 * `/api/show` — not the OpenAI-compatible `/v1` shim. The native path
 * gives us per-request `num_ctx`, a separate `thinking` channel, and
 * tool calls that arrive whole with object arguments.
 *
 * Works against a local `ollama serve` (keyless) and against
 * ollama.com (same wire contract plus a bearer key).
 */
export class OllamaProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  readonly toolCallAdapter: ToolCallAdapter = openAiToolCallAdapter;
  readonly streamConsumer: StreamConsumer | null = null;

  private readonly http: OpenAiHttpDeps;
  private readonly defaultChatModel: string;
  private readonly numCtxByModel = new Map<string, number | undefined>();

  constructor(options: OllamaProviderOptions) {
    this.id = options.id;
    this.name = options.id;
    this.defaultChatModel =
      options.defaultChatModel ?? OLLAMA_DEFAULT_CHAT_MODEL;
    this.capabilities = {
      vision: options.supportsVision ?? false,
      visionSource: options.supportsVision ? "modalities.vision" : "absent",
      toolTransport: "native_tools",
      contextWindow: OLLAMA_AGENT_NUM_CTX,
      supportsParallelTools: options.supportsParallelTools ?? true,
      supportsSlotAffinity: false,
      // Ollama caches prompt prefixes internally, but exposes no cache
      // accounting on the native API, so we do not claim the capability.
      supportsPromptCache: false,
      reasoningFormat: "delta_thinking",
    };
    this.http = {
      baseUrl: normalizeOllamaBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE),
      apiKey: options.apiKey ?? "",
      extraHeaders: options.headers ?? {},
      requestTimeoutMs: options.requestTimeoutMs ?? 600_000,
      fetchImpl: options.fetchImpl ?? fetch,
      label: options.id,
    };
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const numCtx = await this.resolveNumCtx(this.defaultChatModel, request);
    const body = buildOllamaChatBody(
      request,
      this.defaultChatModel,
      false,
      numCtx,
    );
    const json = (await openAiPostJson(
      this.http,
      "/api/chat",
      body,
      request,
    )) as OllamaChatChunk;
    return completionFromOllamaChat(json, this.defaultChatModel);
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    const numCtx = await this.resolveNumCtx(this.defaultChatModel, request);
    const body = buildOllamaChatBody(
      request,
      this.defaultChatModel,
      true,
      numCtx,
    );
    const res = await openAiStartStream(this.http, "/api/chat", body, request);
    const accumulated = { content: "", thinking: "" };
    let final: OllamaChatChunk | null = null;
    const toolCallChunks: OllamaChatChunk[] = [];
    for await (const chunk of consumeOllamaNdjson(
      res.body,
      `${this.http.baseUrl}/api/chat`,
      this.http.label,
      request.signal,
    )) {
      const delta = chunk.message?.content ?? "";
      const reasoningDelta = chunk.message?.thinking ?? "";
      accumulated.content += delta;
      accumulated.thinking += reasoningDelta;
      if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
        toolCallChunks.push(chunk);
      }
      if (chunk.done) {
        final = chunk;
        break;
      }
      if (delta || reasoningDelta) {
        yield { delta, reasoningDelta, done: false };
      }
    }
    // Tool calls may arrive on a non-final chunk; merge every one seen
    // into the closing payload so the adapter sees the full set.
    const mergedToolCalls = toolCallChunks.flatMap(
      (chunk) => chunk.message?.tool_calls ?? [],
    );
    const closing: OllamaChatChunk = {
      ...(final ?? {}),
      message: {
        ...(final?.message ?? {}),
        tool_calls: mergedToolCalls,
      },
    };
    return completionFromOllamaChat(
      closing,
      this.defaultChatModel,
      accumulated,
    );
  }

  async health(): Promise<ProviderHealthResult> {
    const start = Date.now();
    try {
      const res = await this.http.fetchImpl(`${this.http.baseUrl}/api/tags`, {
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
    const start = Date.now();
    const json = (await openAiPostJson(
      this.http,
      "/api/chat",
      {
        model: this.defaultChatModel,
        messages: [
          {
            role: "user",
            content: request.prompt,
            images: request.images.map((image) =>
              Buffer.from(image.bytes).toString("base64"),
            ),
          },
        ],
        stream: false,
        options: {
          ...(typeof request.temperature === "number"
            ? { temperature: request.temperature }
            : {}),
          ...(typeof request.maxTokens === "number"
            ? { num_predict: request.maxTokens }
            : {}),
        },
      },
      request,
    )) as OllamaChatChunk;
    return {
      text: json.message?.content ?? "",
      durationMs: Date.now() - start,
    };
  }

  async listModels(): Promise<readonly string[]> {
    const json = await openAiGetJson(this.http, "/api/tags");
    const models = (json.models as Array<{ name?: string }> | undefined) ?? [];
    return models
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string")
      .sort((a, b) => a.localeCompare(b));
  }

  /**
   * `num_ctx` for a model: `OLLAMA_AGENT_NUM_CTX` capped by the trained
   * context length from `/api/show`, resolved once per model and
   * cached. A failed lookup caches `undefined` so a missing model does
   * not add a round-trip to every completion; the request then carries
   * no `num_ctx` and the server default applies.
   */
  private async resolveNumCtx(
    model: string,
    request: { signal?: AbortSignal },
  ): Promise<number | undefined> {
    if (this.numCtxByModel.has(model)) {
      return this.numCtxByModel.get(model);
    }
    let resolved: number | undefined;
    try {
      const json = await openAiPostJson(
        this.http,
        "/api/show",
        { model },
        request,
      );
      const trained = trainedContextLength(json);
      resolved = trained
        ? Math.min(OLLAMA_AGENT_NUM_CTX, trained)
        : OLLAMA_AGENT_NUM_CTX;
    } catch {
      resolved = undefined;
    }
    this.numCtxByModel.set(model, resolved);
    return resolved;
  }
}

function trainedContextLength(show: Record<string, unknown>): number | null {
  const details = show.details as { context_length?: unknown } | undefined;
  if (typeof details?.context_length === "number" && details.context_length > 0) {
    return details.context_length;
  }
  // Older servers only expose it as `model_info["<arch>.context_length"]`.
  const info = show.model_info as Record<string, unknown> | undefined;
  if (info) {
    for (const [key, value] of Object.entries(info)) {
      if (
        key.endsWith(".context_length") &&
        typeof value === "number" &&
        value > 0
      ) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Base URLs are stored without a path, matching every compat entry in
 * this repo. A pasted `/v1` suffix is stripped defensively: the native
 * API lives at `/api/...`, so a `/v1` root would 404 every call.
 */
export function normalizeOllamaBaseUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    trimmed = trimmed.slice(0, -"/v1".length);
  }
  return trimmed.replace(/\/+$/, "");
}
