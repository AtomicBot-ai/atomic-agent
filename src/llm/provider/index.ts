export {
  VisionUnsupportedError,
  type LlmProvider,
  type ProviderCapabilities,
  type ProviderHealthResult,
  type VisionImage,
  type VisionRequest,
  type VisionResult,
  type CompletionRequest,
  type CompletionResult,
  type CompletionTiming,
  type CompletionUsage,
  type StreamChunk,
  type ToolCallTransport,
} from "./llm-provider.js";
export { LlamaServerProvider } from "./llama-server/index.js";
export {
  ProviderRegistry,
  registerProviderKind,
  knownProviderKinds,
  resolveLlmConfig,
  registerBuiltInProviderKinds,
  resolveActiveToolTransport,
  type LlmProviderConfigEntry,
  type UserModelConfigEntry,
  type ResolvedLlmConfig,
} from "./registry/index.js";
export { resolveModel, type ResolvedModel } from "./model-resolver.js";
export { CostAccumulator, type CostAccumulatorSnapshot } from "./cost-accumulator.js";
export { OpenAiProvider, type OpenAiProviderOptions } from "./openai/index.js";
export { OpenRouterProvider } from "./openrouter/index.js";
export {
  CLAUDE_CLI_CHAT_MODELS,
  CLAUDE_CLI_DEFAULT_CHAT_MODEL,
  SubscriptionCliProvider,
  type SubscriptionCliProviderOptions,
} from "./subscription-cli/index.js";
export {
  GeminiProvider,
  type GeminiProviderOptions,
  DEFAULT_GEMINI_BASE,
  GEMINI_API_PATH_PREFIX,
  GEMINI_DEFAULT_CHAT_MODEL,
} from "./gemini/index.js";
export {
  AimlapiProvider,
  type AimlapiProviderOptions,
  AIMLAPI_CHAT_MODEL_ORDER,
  AIMLAPI_DEFAULT_CHAT_MODEL,
  AIMLAPI_MODELS_CATALOG,
  listAimlapiChatPicks,
  refreshAimlapiChatCatalogFromApi,
  type AimlapiChatPick,
} from "./aimlapi/index.js";
export type { ToolCallAdapter } from "./adapters/tool-call-adapter.js";
export type { StreamConsumer } from "./adapters/stream-consumer.js";
export {
  openAiToolCallAdapter,
  nameEscape,
  nameUnescape,
  descriptorsToOpenAiTools,
  openAiToolCallsToBatch,
} from "./openai/index.js";
