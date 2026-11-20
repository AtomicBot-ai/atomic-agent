import { join } from "node:path";

import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { FileIndex } from "../../tools/files/index.js";

/** Wait before the first catch-up walk, like the memory embedding backfill. */
const FILE_INDEX_START_DELAY_MS = 15_000;

/**
 * The runtime's "My files" index (ATO-1621), in `<stateDir>/files-index.sqlite`.
 *
 * Chunks are embedded with the model memory has attached now
 * (`MemoryStore.currentEmbeddingClient`, so a reattach carries over), and
 * only when that model is served on this machine (Atomic Core or a local
 * `llama-server`): file text never goes to a remote embedding endpoint.
 * Without it, search is FTS5 only. Photos and audio are skipped for now:
 * there is no setting to turn `media-text.ts` on yet.
 *
 * An index that cannot open (a newer schema, a broken file) leaves the
 * runtime without one: the routes answer 501 and `files.search` is not
 * registered. It never stops the boot.
 */
export function createRuntimeFileIndex(args: {
  config: Pick<AtomicAgentConfig, "paths" | "memory" | "localModels">;
  notesStore: Pick<MemoryStore, "currentEmbeddingClient">;
  logger: Pick<StructuredLogger, "warn">;
  startDelayMs?: number;
}): FileIndex | undefined {
  const { config, notesStore, logger } = args;
  const embeddingsStayLocal = isLocalServerUrl(config.localModels.embeddings.url);
  try {
    const index = new FileIndex({
      dbFile: join(config.paths.stateDir, "files-index.sqlite"),
      validation: { protectedDirs: [config.paths.stateDir] },
      embedding: () => (embeddingsStayLocal ? notesStore.currentEmbeddingClient() : null),
      fts5Weight: config.memory.embeddings.fts5Weight,
      vectorWeight: config.memory.embeddings.vectorWeight,
    });
    index.startAfter(args.startDelayMs ?? FILE_INDEX_START_DELAY_MS);
    return index;
  } catch (error) {
    logger.warn("file index unavailable; My files is off for this run", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
