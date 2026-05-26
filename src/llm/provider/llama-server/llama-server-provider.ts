import { getConfig } from "../../../config/index.js";
import { checkLlamaServer } from "../../llama-server-health.js";
import type { LlamaServerClient } from "../../llama-server-client.js";
import type { ModelProfile } from "../../model-profile.js";
import type {
  CompletionRequest,
  CompletionResult,
  StreamChunk,
} from "../completion-types.js";
import {
  VisionUnsupportedError,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderHealthResult,
  type VisionRequest,
  type VisionResult,
} from "../llm-provider.js";
import {
  describeImageViaLlamaServer,
  resolveVisionCapabilities,
} from "./llama-server-vision.js";

/**
 * Provider adapter for vision describe-style calls against an external
 * llama-server. Text completion delegates to `LlamaServerClient`.
 */
export class LlamaServerProvider implements LlmProvider {
  readonly id: string;
  readonly name = "llama.cpp";
  readonly toolCallAdapter = null;
  readonly streamConsumer = null;

  get capabilities(): ProviderCapabilities {
    const visionCaps = resolveVisionCapabilities({
      profile: this.getProfile(),
      visionEnabledByConfig: this.visionEnabledByConfig,
      visionAutoDetect: this.visionAutoDetect,
    });
    return {
      ...visionCaps,
      toolTransport: "grammar",
      contextWindow: this.getProfile().contextWindow ?? 8192,
      supportsParallelTools: true,
      supportsSlotAffinity: true,
      supportsPromptCache: true,
      reasoningFormat:
        this.getProfile().reasoningStyle === "none"
          ? "none"
          : this.getProfile().reasoningStyle === "channel-tags"
            ? "delta_thinking"
            : "delta_reasoning",
    };
  }

  constructor(
    private readonly client: LlamaServerClient,
    options: {
      id?: string;
      getProfile: () => ModelProfile;
      visionEnabledByConfig: boolean;
      visionAutoDetect: boolean;
      maxImageBytes: number;
      maxImagesPerCall: number;
      fetchImpl?: typeof fetch;
      baseUrlOverride?: string;
      requestTimeoutMs?: number;
    },
  ) {
    this.id = options.id ?? "local-llama";
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

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.client.complete(request);
  }

  async *completeStream(
    request: CompletionRequest,
  ): AsyncGenerator<StreamChunk, CompletionResult, void> {
    return yield* this.client.completeStream(request);
  }

  async health(): Promise<ProviderHealthResult> {
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.localModels.url;
    const result = await checkLlamaServer({
      url: base,
      apiKey: config.localModels.apiKey,
    });
    return {
      reachable: result.reachable,
      status: result.status,
      error: result.error,
      latencyMs: result.latencyMs,
    };
  }

  async close(): Promise<void> {
    // llama-server is external; nothing to tear down.
  }

  async describeImage(request: VisionRequest): Promise<VisionResult> {
    if (!this.capabilities.vision) {
      throw new VisionUnsupportedError(this.name);
    }
    const config = getConfig();
    const base = this.baseUrlOverride ?? config.localModels.url;
    return describeImageViaLlamaServer({
      request,
      baseUrl: base,
      maxImageBytes: this.maxImageBytes,
      maxImagesPerCall: this.maxImagesPerCall,
      requestTimeoutMs: this.requestTimeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }
}
