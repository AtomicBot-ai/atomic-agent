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

/**
 * Which field of an OpenAI-compatible message/delta carries the model's
 * reasoning. `auto` (the provider default) reads whichever of
 * `reasoning`, `reasoning_content` and `thinking` is present — OpenRouter,
 * DeepSeek-style servers and Anthropic-compatible shims each use a
 * different one, and a stream whose field is not the configured one used
 * to lose its reasoning silently. The named formats pin one field for a
 * model whose server also writes a *different* field with something that
 * is not reasoning.
 */
export type ReasoningFormat =
  | "auto"
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
    | "auto-detect-disabled"
    // Cloud links: where the per-model answer came from
    // (`model-vision.ts`). `assumed` = nothing describes the model, so it
    // is offered until the service rejects an image; `rejected-images` =
    // it did, and the model is text-only for the rest of the process.
    | "config.userModels"
    | "config.provider"
    | "catalog"
    | "catalog.live"
    | "assumed"
    | "rejected-images";
  /**
   * Whether the model this link serves takes audio input directly
   * (OpenAI-compatible `input_audio` content parts). Optional: absent
   * reads as `false`, so a provider that says nothing is never sent
   * audio. Unlike vision there is no `assumed`: nothing is offered
   * until llama-server `/props` (`modalities.audio`), the operator's
   * config (`supportsAudio`) or the provider's own model list says so.
   * `audio.listen` reads it on every call; a `false` keeps today's path
   * (the file stays on disk for the transcription skill).
   */
  audio?: boolean;
  audioSource?: AudioSource;
  toolTransport: ToolCallTransport;
  contextWindow: number;
  supportsParallelTools: boolean;
  supportsSlotAffinity: boolean;
  supportsPromptCache: boolean;
  reasoningFormat: ReasoningFormat;
}

/** Where `ProviderCapabilities.audio` came from. */
export type AudioSource =
  | "modalities.audio"
  | "absent"
  | "config.userModels"
  | "config.provider"
  | "catalog.live"
  | "unknown";

/** Audio formats an OpenAI-compatible `input_audio` part may carry. */
export type AudioInputFormat = "wav" | "mp3";

export interface AudioRequest {
  prompt: string;
  audio: { bytes: Uint8Array; format: AudioInputFormat };
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
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
   * The chat model this link serves right now, when the provider knows
   * it — named in the refusal when that model cannot read images.
   */
  readonly chatModelId?: string | undefined;
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
  /**
   * Send one audio clip plus a prompt to the chat model as an
   * `input_audio` part. Optional: a provider without it cannot take
   * audio whatever `capabilities.audio` says. Throws
   * `AudioUnsupportedError` when the model takes no audio.
   */
  describeAudio?(request: AudioRequest): Promise<VisionResult>;
  health(): Promise<ProviderHealthResult>;
  close(): Promise<void>;
  listModels?(): Promise<readonly string[]>;
}

export class VisionUnsupportedError extends Error {
  constructor(provider: string, message?: string) {
    super(message ?? `vision is not supported by provider "${provider}"`);
    this.name = "VisionUnsupportedError";
  }
}

export class AudioUnsupportedError extends Error {
  constructor(provider: string, message?: string) {
    super(message ?? `audio input is not supported by provider "${provider}"`);
    this.name = "AudioUnsupportedError";
  }
}

/**
 * The service refused an image for a model nobody had described, and
 * the model is now recorded as text-only (`model-vision-rejections.ts`).
 * A `VisionUnsupportedError`, so every caller that already stops on
 * "cannot see" stops on this too.
 */
export class ModelCannotSeeError extends VisionUnsupportedError {
  constructor(
    readonly providerId: string,
    readonly modelId: string,
    readonly serviceMessage: string,
  ) {
    super(
      providerId,
      `${modelId} on ${providerId} rejected the image (${serviceMessage})`,
    );
    this.name = "ModelCannotSeeError";
  }
}
