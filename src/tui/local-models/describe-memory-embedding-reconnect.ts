import type { MemoryEmbeddingReconnect } from "../../runtime/bootstrap.js";

/**
 * The chat line for a memory reattach after an embedding model change
 * (ATO-351), or `null` when nothing changed (memory already used that
 * model). Says plainly when memory falls back to keyword recall.
 */
export function describeMemoryEmbeddingReconnect(result: MemoryEmbeddingReconnect): string | null {
  if (result.changed === false) return null;
  if (result.health === "ok") {
    return `memory: now using ${result.modelId ?? "the selected model"} for recall; older notes are re-embedded in the background`;
  }
  if (result.health === "disabled") return "memory: embeddings off, recall uses keywords only";
  const why = result.why ? ` (${result.why})` : "";
  return `memory: ${result.modelId ?? "the embedding model"} is not answering${why}; recall uses keywords until it does`;
}
