/**
 * Shared completion request/response shapes for every text LLM provider.
 * `LlamaServerClient` and cloud adapters both speak this surface so the
 * agent loop stays provider-agnostic above the registry seam.
 */

export type ToolCallTransport = "grammar" | "native_tools";

export interface CompletionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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
  repeatPenalty?: number;
  repeatLastN?: number;
  sessionId?: string;
  signal?: AbortSignal;
  imageData?: ReadonlyArray<{ id: number; data: string }>;
  /** OpenAI tools path — ignored by grammar-only providers. */
  tools?: ReadonlyArray<Record<string, unknown>>;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  /**
   * OpenAI-compatible Structured Outputs envelope. When set, the
   * provider attaches `response_format: { type: "json_schema", ... }`
   * to the request so the model is forced to emit valid JSON matching
   * `schema`. Used by reflection/link-gen/vote/rewriter/distill
   * sub-runners on cloud providers — GBNF (`grammar`) cannot be
   * enforced over OpenAI-compatible APIs, so this is the cross-vendor
   * equivalent. Ignored by grammar-only providers (llama-server) —
   * they rely on `grammar` instead.
   */
  responseFormat?: ResponseFormatJsonSchema;
}

/**
 * OpenAI-compatible Structured Outputs descriptor. Mirrors the
 * `response_format` payload accepted by chat-completions when
 * `type === "json_schema"`. `strict: true` is the recommended
 * default — it makes the provider validate against `schema` server-side
 * and rejects malformed completions before they hit our parsers.
 */
export interface ResponseFormatJsonSchema {
  /** Short identifier exposed to the provider (must match `^[a-zA-Z0-9_-]+$`). */
  name: string;
  /** Human-readable description of what the schema captures. Optional. */
  description?: string;
  /** JSON Schema object. Should be self-contained — no $ref. */
  schema: Record<string, unknown>;
  /**
   * When true, the provider enforces strict adherence to `schema`
   * (every property in `required`, no extra fields beyond what
   * `additionalProperties: false` allows). Defaults to true at the
   * provider adapter level.
   */
  strict?: boolean;
}

export interface CompletionTiming {
  promptMs: number;
  predictedMs: number;
  promptTokens: number;
  predictedTokens: number;
}

export interface CompletionResult {
  content: string;
  reasoningContent: string;
  stop: boolean;
  truncated: boolean;
  timing: CompletionTiming;
  cacheHitTokens: number;
  slotId: number;
  modelId: string | null;
  /** Populated by cloud providers from `usage` blocks. */
  usage?: CompletionUsage;
  /** Raw OpenAI tool_calls when transport is native_tools. */
  toolCalls?: ReadonlyArray<OpenAiToolCall>;
  finishReason?: string | null;
  /**
   * Tool-call transport of the provider that actually served this
   * completion. Providers never set it — it is stamped by the fallback
   * chain wrapper so the caller parses the response with the transport of
   * the link that answered, not the primary's. Absent on the direct
   * (non-wrapped) path, where the caller's own `toolTransport` is
   * authoritative.
   */
  servedTransport?: ToolCallTransport;
}

export interface OpenAiToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  delta: string;
  reasoningDelta: string;
  done: boolean;
}

export interface StreamFinalResult {
  content: string;
  reasoningContent: string;
  toolCalls?: ReadonlyArray<OpenAiToolCall>;
  finishReason?: string | null;
  usage?: CompletionUsage;
  modelId?: string | null;
  /**
   * Whether the underlying transport actually delivered a trustworthy
   * terminal signal — an explicit provider `finish_reason` on any chunk,
   * or a parser-recognized terminal event (e.g. `[DONE]`) — before the
   * stream ended. `false` (or absent) means the connection just closed
   * (bare EOF / read error) without either: not asserted, so callers must
   * not treat an absent value as confirmation of a clean completion.
   */
  terminalObserved?: boolean;
}
