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
}
