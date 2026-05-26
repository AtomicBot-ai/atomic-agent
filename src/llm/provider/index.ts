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
export type { ToolCallAdapter } from "./adapters/tool-call-adapter.js";
export type { StreamConsumer } from "./adapters/stream-consumer.js";
export {
  openAiToolCallAdapter,
  nameEscape,
  nameUnescape,
  descriptorsToOpenAiTools,
  openAiToolCallsToBatch,
} from "./openai/index.js";
