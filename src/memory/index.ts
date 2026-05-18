export { MEMORY_SCHEMA_VERSION, applyMigrations } from "./memory-schema.js";
export type { MemoryDatabaseLike } from "./memory-schema.js";
export {
  ProfileStore,
  ProfileValidationError,
  PROFILE_KEY_MAX_LENGTH,
  PROFILE_VALUE_MAX_LENGTH,
  PROFILE_KEYWORDS_MAX,
  PROFILE_KEYWORD_MAX_LENGTH,
} from "./profile-store.js";
export type {
  ProfileFact,
  ProfileStoreOptions,
  ProfileSetOptions,
} from "./profile-store.js";
export {
  MemoryStore,
  MemoryValidationError,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_TAG_MAX_LENGTH,
  MEMORY_MAX_TAGS,
  MEMORY_QUERY_MAX_LENGTH,
  MEMORY_RECALL_DEFAULT_K,
  MEMORY_RECALL_MAX_K,
  MEMORY_LIST_MAX_LIMIT,
  MEMORY_INDEX_PREVIEW_CHARS_DEFAULT,
  MEMORY_INDEX_PREVIEW_CHARS_MAX,
  renderNotePreview,
} from "./memory-store.js";
export type {
  MemoryEntry,
  MemoryIndexEntry,
  MemoryIndexOptions,
  MemorySource,
  MemoryStoreOptions,
  MemoryStoreInput,
  MemoryRecallOptions,
  MemoryListOptions,
} from "./memory-store.js";
export { renderProfileSection } from "./profile-renderer.js";
export {
  renderRecalledSection,
  renderRecalledLine,
  renderMemoryIndexSection,
} from "./notes-renderer.js";
export { createDefaultMemoryContextProvider } from "./memory-context-provider.js";
export type { DefaultMemoryContextProviderOptions } from "./memory-context-provider.js";
export {
  EmbeddingStore,
  EmbeddingUnavailableError,
  EmbeddingWriter,
  LlamaEmbeddingClient,
  cosineSimilarity,
  recallHybrid,
} from "./embeddings/index.js";
export type {
  EmbeddingClient,
  EmbedRequest,
  EmbedResult,
  EmbeddingRow,
  HybridRecallDeps,
  HybridRecallInputEntry,
  HybridRecallOptions,
  LlamaEmbeddingClientOptions,
} from "./embeddings/index.js";
