export {
  EmbeddingUnavailableError,
  LlamaEmbeddingClient,
} from "./embedding-client.js";
export type {
  EmbeddingClient,
  EmbedRequest,
  EmbedResult,
  LlamaEmbeddingClientOptions,
} from "./embedding-client.js";

export { EmbeddingStore } from "./embedding-store.js";
export type {
  EmbeddingRow,
  EmbeddingStoreOptions,
} from "./embedding-store.js";

export { EmbeddingWriter } from "./embedding-writer.js";
export type { EmbeddingWriterDeps } from "./embedding-writer.js";

export {
  cosineSimilarity,
  recallHybrid,
} from "./hybrid-recall.js";
export type {
  HybridRecallDeps,
  HybridRecallInputEntry,
  HybridRecallOptions,
} from "./hybrid-recall.js";
