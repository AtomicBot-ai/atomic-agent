import type { AtomicAgentConfig } from "../../../config/index.js";
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
  supportsTools?: boolean;
  supportsVision?: boolean;
  requestTimeoutMs?: number;
  promptCache?: "auto" | "off" | "explicit-markers";
  providerPreferences?: Record<string, unknown>;
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

export type ResolvedLlmConfig = {
  activeTextProvider: string;
  activeEmbeddingProvider: string;
  providers: LlmProviderConfigEntry[];
  toolTransport: "auto" | "grammar" | "native_tools";
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
