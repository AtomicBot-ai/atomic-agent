/**
 * Provider-agnostic LLM surface used by the multimodal toolset and any
 * future non-llamacpp backends. Kept deliberately narrow — only the
 * verbs the runtime actually invokes through the abstraction. Text
 * completion stays on the existing `LlamaServerClient` direct path
 * because the agent loop relies on llama.cpp-specific knobs
 * (`slot_id`, `cache_prompt`, GBNF grammar) that no current third
 * party emulates fully.
 *
 * When we add a second provider (e.g. OpenAI / Anthropic) the
 * `LlmProvider` interface is the contract the new adapter implements.
 * Callers depend only on this file plus the request/response shapes
 * exported below.
 */

/**
 * Snapshot of what a provider can do, returned once per bootstrap.
 * Mirrors the relevant subset of `ModelProfile` (text-only) plus
 * provider-level facts that aren't model-specific (e.g. whether the
 * underlying API supports the `image_data` extension).
 */
export interface ProviderCapabilities {
  /** Whether the provider exposes a `describeImage` path at all. */
  vision: boolean;
  /** Wire reason — surfaced in trace logs for postmortems. */
  visionSource:
    | "modalities.vision"
    | "has_multimodal"
    | "multimodal"
    | "mmproj"
    | "default_generation_settings.has_multimodal"
    | "absent"
    | "config-disabled"
    | "auto-detect-disabled";
}

/**
 * Single image attached to a vision request. `data` is the raw bytes;
 * the provider is responsible for any base64 encoding / size checks
 * its wire protocol requires.
 */
export interface VisionImage {
  /** Stable id used to reference the image from the prompt body. */
  id: number;
  /** Decoded image bytes (PNG/JPEG/WEBP) — provider validates further. */
  bytes: Uint8Array;
  /** MIME type, e.g. `image/png`. Not strictly required by llama.cpp but useful for OpenAI-shape adapters. */
  mimeType: string;
}

export interface VisionRequest {
  /**
   * Free-form user instruction that accompanies the image(s). The
   * provider stitches it together with `[img-<id>]` placeholders for
   * llama.cpp's `/completion` `image_data` extension, or with
   * OpenAI-shape `content` parts for chat-completion adapters.
   */
  prompt: string;
  images: ReadonlyArray<VisionImage>;
  /** Soft cap on output tokens. The provider may further bound this. */
  maxTokens?: number;
  /**
   * Optional sampling temperature override. Defaults to a low value
   * suitable for descriptive captions; the agent loop does not need to
   * tune this per call.
   */
  temperature?: number;
  /** Honour cooperative cancellation from the agent loop. */
  signal?: AbortSignal;
}

export interface VisionResult {
  /** Plain-text description produced by the model. */
  text: string;
  /** Wall-clock duration of the underlying HTTP call. */
  durationMs: number;
}

/**
 * Minimal provider surface. Today only the vision verb is exposed
 * because text completion still goes through `LlamaServerClient`
 * directly — see the module-level doc comment above.
 */
export interface LlmProvider {
  /** Provider tag for logs / metrics, e.g. `"llama.cpp"`, `"openai"`. */
  readonly name: string;
  /** Cached capabilities snapshot taken at bootstrap. */
  readonly capabilities: ProviderCapabilities;
  /**
   * Run a multimodal description call. Implementations must throw
   * when `capabilities.vision === false` — callers should gate on
   * `capabilities` instead of catching the error.
   */
  describeImage(request: VisionRequest): Promise<VisionResult>;
}

export class VisionUnsupportedError extends Error {
  constructor(provider: string) {
    super(`vision is not supported by provider "${provider}"`);
    this.name = "VisionUnsupportedError";
  }
}
