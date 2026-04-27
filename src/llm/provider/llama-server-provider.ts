import { getConfig } from "../../config/index.js";
import type { LlamaServerClient } from "../llama-server-client.js";
import type { ModelProfile } from "../model-profile.js";
import {
  VisionUnsupportedError,
  type LlmProvider,
  type ProviderCapabilities,
  type VisionRequest,
  type VisionResult,
} from "./llm-provider.js";

/**
 * Provider adapter for vision describe-style calls against an external
 * llama-server. Speaks the OpenAI-compatible `/v1/chat/completions`
 * endpoint with `image_url` content blocks instead of the legacy
 * `/completion` + `image_data` + `[img-<id>]` plain-text path.
 *
 * Why chat-completions and not `/completion`?
 *   1. Modern multimodal GGUFs (Gemma-4 `gemma4v`, Qwen3-VL
 *      `qwen3vl_merger`) require their model-specific chat template
 *      (`<start_of_turn>...<start_of_image>...`, `<|im_start|>user
 *      <|vision_start|>...<|vision_end|>...`) for the clip embedding
 *      to actually bridge into the LLM context. Sending plain
 *      `[img-1]\n\nprompt\n\nDescription:` with no template makes the
 *      Gemma-4 family devolve into repeated gibberish ("Description:
 *      Description: deeding deeding…"); Qwen-VL hallucinates
 *      confidently-wrong captions. `/v1/chat/completions` lets
 *      llama-server apply the model's real Jinja template from GGUF
 *      metadata. Verified live against Gemma-4-26B-A4B with mmproj-F16:
 *      this path produces accurate descriptions, the legacy path does
 *      not.
 *   2. `chat_template_kwargs.enable_thinking=false` is required for
 *      Gemma-4: without it the entire reply lands in the `thinking`
 *      channel and `choices[0].message.content` comes back empty.
 *
 * Concurrency: vision calls do **not** thread a slot id (the
 * chat-completions endpoint manages slots internally for multimodal
 * batches). The main agent slot and the reflection slot are not
 * touched. See `AGENTS.md > Concurrency contract` for context.
 */
export class LlamaServerProvider implements LlmProvider {
  readonly name = "llama.cpp";

  /**
   * `capabilities` is a getter (not a frozen field) on purpose. The TUI
   * starts the runtime with `deferLlamaHealthCheck=true` so the initial
   * profile is the `plain-instruct` fallback (no vision); the
   * `ModelProfileManager` then hot-swaps to the real profile once the
   * first `/props` probe lands. Capturing capabilities at construction
   * time would freeze the provider on the cold-start fallback for the
   * entire session — which is exactly the bug session 8b316d revealed.
   * Reading the live profile through `getProfile` instead lets vision
   * become available the moment the manager refreshes.
   */
  get capabilities(): ProviderCapabilities {
    return resolveCapabilities({
      profile: this.getProfile(),
      visionEnabledByConfig: this.visionEnabledByConfig,
      visionAutoDetect: this.visionAutoDetect,
    });
  }

  constructor(
    _client: LlamaServerClient,
    options: {
      getProfile: () => ModelProfile;
      visionEnabledByConfig: boolean;
      visionAutoDetect: boolean;
      maxImageBytes: number;
      maxImagesPerCall: number;
      /**
       * Override fetch used to talk to `/v1/chat/completions`. Tests inject
       * a deterministic mock; production reads the global `fetch`.
       */
      fetchImpl?: typeof fetch;
      /**
       * Override base URL. When omitted, every call resolves
       * `getConfig().localModels.url` so config hot-reloads land
       * automatically.
       */
      baseUrlOverride?: string;
      /**
       * Per-request timeout for the chat-completions call. Vision is
       * slower than text completions (clip encode + LLM decode), so the
       * default sits well above the text completion timeout.
       */
      requestTimeoutMs?: number;
    },
  ) {
    this.getProfile = options.getProfile;
    this.visionEnabledByConfig = options.visionEnabledByConfig;
    this.visionAutoDetect = options.visionAutoDetect;
    this.maxImageBytes = options.maxImageBytes;
    this.maxImagesPerCall = options.maxImagesPerCall;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrlOverride = options.baseUrlOverride;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  private readonly getProfile: () => ModelProfile;
  private readonly visionEnabledByConfig: boolean;
  private readonly visionAutoDetect: boolean;
  private readonly maxImageBytes: number;
  private readonly maxImagesPerCall: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrlOverride: string | undefined;
  private readonly requestTimeoutMs: number;

  async describeImage(request: VisionRequest): Promise<VisionResult> {
    if (!this.capabilities.vision) {
      throw new VisionUnsupportedError(this.name);
    }
    if (request.images.length === 0) {
      throw new Error("vision.describe requires at least one image");
    }
    if (request.images.length > this.maxImagesPerCall) {
      throw new Error(
        `vision.describe accepts at most ${this.maxImagesPerCall} images per call`,
      );
    }
    for (const img of request.images) {
      if (img.bytes.byteLength > this.maxImageBytes) {
        throw new Error(
          `image #${img.id} exceeds maxImageBytes (${this.maxImageBytes})`,
        );
      }
    }

    const config = getConfig();
    const base = this.baseUrlOverride ?? config.localModels.url;
    const url = new URL("/v1/chat/completions", base).toString();

    const userContent: Array<
      | { type: "image_url"; image_url: { url: string } }
      | { type: "text"; text: string }
    > = [];
    for (const img of request.images) {
      const mime = detectImageMime(img.bytes);
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:${mime};base64,${bytesToBase64(img.bytes)}`,
        },
      });
    }
    userContent.push({ type: "text", text: request.prompt });

    const body = JSON.stringify({
      messages: [{ role: "user", content: userContent }],
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.1,
      stream: false,
      // Gemma-4 (and any thinking-capable model) routes the entire
      // reply into a separate `thinking` channel by default, leaving
      // `choices[0].message.content` empty. Disable that for vision
      // describe — we want the surface caption, not chain-of-thought.
      // Models without a thinking channel ignore this kwarg.
      chat_template_kwargs: { enable_thinking: false },
      reasoning_format: "none",
    });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (config.localModels.apiKey) {
      headers.authorization = `Bearer ${config.localModels.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    const start = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`vision request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `vision request returned http ${res.status}: ${errBody.slice(0, 200)}`,
      );
    }
    const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
    const content = json?.choices?.[0]?.message?.content ?? "";

    return {
      text: content.trim(),
      durationMs: Date.now() - start,
    };
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

/**
 * Sniff a few well-known JPEG/PNG/GIF/WebP magic numbers so we can pick
 * the right `data:` MIME type for the OpenAI-style image_url block.
 * llama.cpp's mtmd loader auto-detects from the bytes anyway, but
 * downstream proxies (and our own future clients) prefer a correct
 * content type.
 */
function detectImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  return "application/octet-stream";
}

function resolveCapabilities(opts: {
  profile: ModelProfile;
  visionEnabledByConfig: boolean;
  visionAutoDetect: boolean;
}): ProviderCapabilities {
  if (!opts.visionEnabledByConfig) {
    return { vision: false, visionSource: "config-disabled" };
  }
  if (!opts.visionAutoDetect) {
    // Operator pinned: trust the local model definition / default to
    // supported. The actual completion path will surface a clear
    // llama-server error if mmproj is in fact not loaded.
    return { vision: true, visionSource: "auto-detect-disabled" };
  }
  return {
    vision: opts.profile.vision.supported,
    visionSource: opts.profile.vision.source,
  };
}

/**
 * Convert a byte buffer into a base64 string without going through
 * `Buffer` (Node) vs `btoa` (Web) branching boilerplate at every
 * call site. We use `Buffer` because the runtime is Node-only.
 */
function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
