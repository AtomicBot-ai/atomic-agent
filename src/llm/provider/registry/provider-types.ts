import type { AtomicAgentConfig } from "../../../config/index.js";
import type { UserSubscriptionCliOptions } from "../../../config/llm-config.js";
import type { LlamaServerClient } from "../../llama-server-client.js";
import type { ModelProfile } from "../../model-profile.js";
import type { StructuredLogger } from "../../../tracing/index.js";
import type { LlmProvider } from "../llm-provider.js";

export type ProviderFactoryContext = {
  config: AtomicAgentConfig;
  entry: LlmProviderConfigEntry;
  llamaClient?: LlamaServerClient;
  getProfile?: () => ModelProfile;
  logger: StructuredLogger;
};

export type ProviderFactory = (
  ctx: ProviderFactoryContext,
) => LlmProvider | Promise<LlmProvider>;

export type LlmProviderConfigEntry = {
  id: string;
  kind: string;
  url?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  defaultChatModel?: string;
  defaultEmbeddingModel?: string;
  headers?: Record<string, string>;
  /**
   * Header that carries this entry's API key when the service does not
   * accept `Authorization: Bearer` (Anthropic wants `x-api-key`). Rides
   * on the entry, not on the preset table, so the saved provider keeps
   * working after a restart. See `openai/openai-auth-headers.ts`.
   */
  apiKeyHeader?: string;
  supportsTools?: boolean;
  supportsVision?: boolean;
  requestTimeoutMs?: number;
  promptCache?: "auto" | "off" | "explicit-markers";
  providerPreferences?: Record<string, unknown>;
  /**
   * Vendor-specific fields merged into the OpenAI-compatible chat
   * completion body. Lets a deployment reach extensions that are not
   * part of the OpenAI schema (e.g. Alibaba Model Studio's
   * `chat_template_kwargs.enable_thinking`) without a code change per
   * vendor.
   *
   * **Reserved keys win.** `model`, `messages`, `stream` and `tools`
   * are re-applied after the merge, so a stray entry can never detach
   * the request from the resolved model or drop the tool contract.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Settings for a `subscription-cli` provider — which vendor CLI to
   * drive and how to invoke it. Absent on every other kind.
   */
  subscriptionCli?: UserSubscriptionCliOptions;
  userModels?: ReadonlyArray<UserModelConfigEntry>;
};

export type UserModelConfigEntry = {
  id: string;
  kind: "chat" | "embedding";
  contextWindow?: number;
  dim?: number;
  supportsVision?: boolean;
  supportsTools?: "none" | "basic" | "parallel" | "strict";
  supportsPromptCache?: boolean;
  reasoningFormat?: LlmProvider["capabilities"]["reasoningFormat"];
  pricing?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
};

export type LlmFallbackConfig = {
  /** Ordered provider ids to fall over through (primary first). */
  chain?: readonly string[];
  /** Auto-append the configured local (llama-server) provider to the tail. Default true. */
  appendLocal?: boolean;
  /** Consecutive advance-worthy failures before switching (non-immediate signals). */
  failureThreshold?: number;
  /** Escalating cooldown ladder in ms; the last entry is the cap. */
  cooldownMs?: readonly number[];
  /** Minimum gap between two primary probes, in ms. */
  probeThrottleMs?: number;
  /** No-error window after which the failure counter resets, in ms. */
  failureWindowMs?: number;
};

export type ResolvedLlmConfig = {
  activeTextProvider: string;
  activeEmbeddingProvider: string;
  providers: LlmProviderConfigEntry[];
  toolTransport: "auto" | "grammar" | "native_tools";
  fallback?: LlmFallbackConfig;
};

const factories = new Map<string, ProviderFactory>();

export function registerProviderKind(
  kind: string,
  factory: ProviderFactory,
): void {
  factories.set(kind, factory);
}

export function knownProviderKinds(): readonly string[] {
  return [...factories.keys()];
}

export function getProviderFactory(kind: string): ProviderFactory | undefined {
  return factories.get(kind);
}

export function resolveLlmConfig(config: AtomicAgentConfig): ResolvedLlmConfig {
  const llm = config.llm;
  if (llm) {
    return {
      activeTextProvider: llm.activeTextProvider,
      activeEmbeddingProvider: llm.activeEmbeddingProvider,
      providers: [...llm.providers],
      toolTransport: llm.toolTransport,
      ...(llm.fallback ? { fallback: llm.fallback } : {}),
    };
  }
  return {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama-embed",
    providers: [
      {
        id: "local-llama",
        kind: "llama-server",
        url: config.localModels.url,
        apiKey: config.localModels.apiKey ?? undefined,
      },
    ],
    toolTransport: "auto",
  };
}
