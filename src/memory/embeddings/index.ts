export {
  EmbeddingUnavailableError,
  LlamaEmbeddingClient,
  promptedEmbeddingText,
} from "./embedding-client.js";
export { createLocalEmbeddingClient } from "./local-embedding-client.js";
export type {
  EmbeddingClient,
  EmbeddingPrompts,
  EmbeddingPurpose,
  EmbedRequest,
  EmbedResult,
  LlamaEmbeddingClientOptions,
} from "./embedding-client.js";

export { EmbeddingStore } from "./embedding-store.js";
export type { EmbeddingRow, EmbeddingStoreOptions } from "./embedding-store.js";

export { EmbeddingWriter } from "./embedding-writer.js";
export type { EmbeddingWriteOutcome, EmbeddingWriterDeps } from "./embedding-writer.js";

export { backfillEmbeddings, countPendingEmbeddings } from "./embedding-backfill.js";
export type {
  EmbeddingBackfillDeps,
  EmbeddingBackfillOptions,
  EmbeddingBackfillProgress,
  EmbeddingBackfillResult,
  EmbeddingBackfillStopReason,
} from "./embedding-backfill.js";

export { cosineSimilarity, recallHybrid } from "./hybrid-recall.js";
export type {
  HybridRecallDeps,
  HybridRecallInputEntry,
  HybridRecallOptions,
} from "./hybrid-recall.js";
