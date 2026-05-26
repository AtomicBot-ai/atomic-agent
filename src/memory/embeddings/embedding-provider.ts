/**
 * Re-exports the embedding client surface used across memory-v2.
 * Cloud adapters implement the same `EmbeddingClient` contract.
 */
export {
  EmbeddingUnavailableError,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingClient as EmbeddingProvider,
} from "./embedding-client.js";
