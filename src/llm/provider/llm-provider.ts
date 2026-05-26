/**
 * Provider-agnostic LLM surface for text completion, vision, and
 * native tool-calling. Text completion historically lived on
 * `LlamaServerClient` directly; the registry seam routes every call
 * through `LlmProvider` so cloud backends plug in without touching the
 * agent loop.
 */

import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
  ToolCallTransport,
} from "./completion-types.js";
import type { StreamConsumer } from "./adapters/stream-consumer.js";
import type { ToolCallAdapter } from "./adapters/tool-call-adapter.js";

export type {
  CompletionRequest,
  CompletionResult,
  CompletionTiming,
  CompletionUsage,
  OpenAiToolCall,
  StreamChunk,
  ToolCallTransport,
} from "./completion-types.js";

export interface ProviderHealthResult {
  reachable: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number;
}

export type ToolsSupportLevel = "none" | "basic" | "parallel" | "strict";

export type ReasoningFormat =
  | "none"
  | "delta_reasoning"
  | "delta_thinking"
  | "delta_reasoning_content";

/**
 * Snapshot of what a provider can do. `toolTransport` drives whether
 * step-executor sends GBNF or native OpenAI tools.
 */
export interface ProviderCapabilities {
  vision: boolean;
  visionSource:
    | "modalities.vision"
    | "has_multimodal"
    | "multimodal"
    | "mmproj"
    | "default_generation_settings.has_multimodal"
    | "absent"
    | "config-disabled"
    | "auto-detect-disabled";
  toolTransport: ToolCallTransport;
  contextWindow: number;
  supportsParallelTools: boolean;
  supportsSlotAffinity: boolean;
  supportsPromptCache: boolean;
  reasoningFormat: ReasoningFormat;
}

export interface VisionImage {
  id: number;
  bytes: Uint8Array;
  mimeType: string;
}

export interface VisionRequest {
  prompt: string;
  images: ReadonlyArray<VisionImage>;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface VisionResult {
  text: string;
  durationMs: number;
}

export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * Native tool mapper. Absent for grammar-only llama-server providers
   * where GBNF enforces the wire shape instead.
   */
  readonly toolCallAdapter: ToolCallAdapter | null;
  readonly streamConsumer: StreamConsumer | null;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void>;
  describeImage(request: VisionRequest): Promise<VisionResult>;
  health(): Promise<ProviderHealthResult>;
  close(): Promise<void>;
  listModels?(): Promise<readonly string[]>;
}

export class VisionUnsupportedError extends Error {
  constructor(provider: string) {
    super(`vision is not supported by provider "${provider}"`);
    this.name = "VisionUnsupportedError";
  }
}
