import { join } from "node:path";

import type { AtomicAgentConfig } from "../../config/config-schema.js";
import { isLocalServerUrl } from "../../llm/provider/openai/local-server-url.js";
import type { MemoryStore } from "../../memory/memory-store.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { FileIndex, rerankerFromEnv } from "../../tools/files/index.js";
import type { MediaTextOptions, VisionModel } from "../../tools/os/media-text/media-text.js";
import { createFallbackOcrEngine } from "../../tools/os/media-text/fallback-ocr-engine.js";
import { tesseractDataDir } from "../../tools/os/media-text/tesseract-data.js";
import { createTesseractOcrEngine } from "../../tools/os/media-text/tesseract-ocr-engine.js";
import { createVisionOcrEngine } from "../../tools/os/media-text/vision-ocr-engine.js";
import type { OcrEngine } from "../../tools/os/read-document/extractors/ocr-engine.js";

/** Wait before the first catch-up walk, like the memory embedding backfill. */
const FILE_INDEX_START_DELAY_MS = 15_000;

/**
 * The runtime's "My files" index (ATO-1621), in `<stateDir>/files-index.sqlite`.
 *
 * Chunks are embedded with the model memory has attached now
 * (`MemoryStore.currentEmbeddingClient`, so a reattach carries over), and
 * only when that model is served on this machine (Atomic Core or a local
 * `llama-server`): file text never goes to a remote embedding endpoint.
 * Without it, search is FTS5 only. Scanned PDF pages, photos and audio
 * are read only while `vision.indexFiles` is on (ATO-2501, read live):
 * scans and photos by a vision model served on this machine
 * (`file-index-vision.ts`, never a cloud one), with tesseract.js as the
 * offline fallback for scans when it is installed and its language data
 * is on disk (ATO-2502), audio by whisper.cpp with
 * a speech model already on disk (nothing is downloaded from here). When
 * the setting is on at boot, files skipped earlier for want of a reader
 * are queued again. Vector candidates
 * come from `sqlite-vec` when that package is installed, and the best
 * hits are reranked only when `ATOMIC_AGENT_RERANK_URL` names a local
 * reranker (ATO-1052); both are off otherwise.
 *
 * An index that cannot open (a newer schema, a broken file) leaves the
 * runtime without one: the routes answer 501 and `files.search` is not
 * registered. It never stops the boot.
 */
export function createRuntimeFileIndex(args: {
  config: Pick<AtomicAgentConfig, "paths" | "memory" | "localModels" | "vision">;
  notesStore: Pick<MemoryStore, "currentEmbeddingClient">;
  logger: Pick<StructuredLogger, "warn">;
  /** The live config (`getConfig`), for `vision.indexFiles`. Default: the boot `config`. */
  readConfig?: () => Pick<AtomicAgentConfig, "paths" | "vision">;
  /** A vision model on this machine, read per file (`createLocalVisionSlot().read`). */
  localVision?: () => VisionModel | undefined;
  startDelayMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}): FileIndex | undefined {
  const { config, notesStore, logger } = args;
  const embeddingsStayLocal = isLocalServerUrl(config.localModels.embeddings.url);
  const readers = fileIndexReaders({
    readConfig: args.readConfig ?? (() => config),
    localVision: args.localVision ?? (() => undefined),
  });
  try {
    const index = new FileIndex({
      dbFile: join(config.paths.stateDir, "files-index.sqlite"),
      validation: { protectedDirs: [config.paths.stateDir] },
      embedding: () => (embeddingsStayLocal ? notesStore.currentEmbeddingClient() : null),
      fts5Weight: config.memory.embeddings.fts5Weight,
      vectorWeight: config.memory.embeddings.vectorWeight,
      reranker: rerankerFromEnv(args.env ?? process.env, (message) => logger.warn(message)),
      media: readers.media,
      ocr: { engine: readers.ocr },
    });
    if (readers.enabled()) index.requeueSkipped();
    index.startAfter(args.startDelayMs ?? FILE_INDEX_START_DELAY_MS);
    return index;
  } catch (error) {
    logger.warn("file index unavailable; My files is off for this run", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * What reads scans, photos and audio for the index, each answered per
 * file from the live setting: `undefined` while `vision.indexFiles` is
 * off, so the index skips them with the reason, as before.
 */
export function fileIndexReaders(deps: {
  readConfig: () => Pick<AtomicAgentConfig, "paths" | "vision">;
  localVision: () => VisionModel | undefined;
}): { enabled: () => boolean; media: () => MediaTextOptions | undefined; ocr: () => OcrEngine | undefined } {
  const enabled = (): boolean => {
    const vision = deps.readConfig().vision;
    return vision.enabled && vision.indexFiles === true;
  };
  // `vision.enabled: false` is the master switch: no image goes to any
  // model then, so photos and scans stay skipped. Audio needs no vision
  // model, but it is the same setting, so it follows it too.
  // Scans: the local vision model first (unchanged), tesseract.js when
  // no vision model is ready (ATO-2502). Which one leads when both are
  // there waits for the Russian-scan measurement.
  const engine = createFallbackOcrEngine([
    createVisionOcrEngine({
      vision: deps.localVision,
      maxImageBytes: deps.readConfig().vision.maxImageBytes,
    }),
    createTesseractOcrEngine({ dataDir: () => tesseractDataDir(deps.readConfig().paths.localModelsDataDir) }),
  ]);
  return {
    enabled,
    media: () => {
      if (!enabled()) return undefined;
      const config = deps.readConfig();
      return {
        enabled: true,
        vision: deps.localVision,
        maxImageBytes: config.vision.maxImageBytes,
        localModelsDataDir: config.paths.localModelsDataDir,
        allowModelDownload: false,
      };
    },
    ocr: () => (enabled() ? engine : undefined),
  };
}
