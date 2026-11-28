import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { FileIndex } from "../../tools/files/index.js";
import type { VisionModel } from "../../tools/os/media-text/media-text.js";
import { createRuntimeFileIndex, fileIndexReaders } from "./runtime-file-index.js";

// ATO-2501: `vision.indexFiles` hands My files its readers, read live.
type ReaderConfig = Pick<AtomicAgentConfig, "paths" | "vision">;

function readerConfig(vision: Partial<AtomicAgentConfig["vision"]>): ReaderConfig {
  return {
    paths: { localModelsDataDir: "/models" },
    vision: { enabled: true, autoDetect: true, maxImageBytes: 1024, maxImagesPerCall: 4, ...vision },
  } as unknown as ReaderConfig;
}

const localModel = { name: "local-vlm", capabilities: { vision: true } } as unknown as VisionModel;

describe("fileIndexReaders", () => {
  it("hands no reader while vision.indexFiles is off", () => {
    const readers = fileIndexReaders({ readConfig: () => readerConfig({}), localVision: () => localModel });
    expect(readers.enabled()).toBe(false);
    expect(readers.media()).toBeUndefined();
    expect(readers.ocr()).toBeUndefined();
  });

  it("hands the local vision model and whisper, never a download, once it is on", () => {
    let config = readerConfig({ indexFiles: false });
    const readers = fileIndexReaders({ readConfig: () => config, localVision: () => localModel });
    config = readerConfig({ indexFiles: true });
    expect(readers.enabled()).toBe(true);
    const media = readers.media();
    expect(media).toMatchObject({ enabled: true, maxImageBytes: 1024, localModelsDataDir: "/models", allowModelDownload: false });
    expect(typeof media?.vision === "function" ? media.vision() : media?.vision).toBe(localModel);
    expect(readers.ocr()?.id).toBe("vision-model or tesseract-js");
  });

  it("stays off while vision itself is switched off", () => {
    const readers = fileIndexReaders({ readConfig: () => readerConfig({ enabled: false, indexFiles: true }), localVision: () => localModel });
    expect(readers.enabled()).toBe(false);
    expect(readers.ocr()).toBeUndefined();
  });

  it("says why a scan stays unread when nothing local reads images", async () => {
    const readers = fileIndexReaders({ readConfig: () => readerConfig({ indexFiles: true }), localVision: () => undefined });
    // tesseract.js is the fallback (ATO-2502); with no data folder on disk it is not ready either.
    const reason = await readers.ocr()?.unavailableReason(["rus", "eng"]);
    expect(reason).toMatch(/^no vision model is configured; tesseract/);
  });
});

describe("createRuntimeFileIndex", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-runtime-file-index-")));
    mkdirSync(join(root, "home"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function runtimeConfig(indexFiles: boolean): Parameters<typeof createRuntimeFileIndex>[0]["config"] {
    return {
      paths: { stateDir: join(root, "state"), localModelsDataDir: join(root, "models") },
      memory: { embeddings: { fts5Weight: 0.5, vectorWeight: 0.5 } },
      localModels: { embeddings: { url: "http://127.0.0.1:9932" } },
      vision: { enabled: true, autoDetect: true, maxImageBytes: 1024, maxImagesPerCall: 4, indexFiles },
    } as unknown as Parameters<typeof createRuntimeFileIndex>[0]["config"];
  }

  async function seedSkippedPhoto(): Promise<void> {
    const photos = join(root, "photos");
    mkdirSync(photos);
    writeFileSync(join(photos, "receipt.png"), "not really a png");
    const seed = new FileIndex({
      dbFile: join(root, "state", "files-index.sqlite"),
      validation: { systemDirs: [], home: join(root, "home") },
      vectorExtension: false,
    });
    await seed.addFolder(photos);
    await seed.idle();
    expect(seed.status()).toMatchObject({ skipped: 1 });
    await seed.close();
  }

  const quiet = { warn: () => undefined };
  const noEmbeddings = { currentEmbeddingClient: () => null };

  it("queues files skipped for want of a reader again when the setting is on at boot", async () => {
    await seedSkippedPhoto();
    const index = createRuntimeFileIndex({ config: runtimeConfig(true), notesStore: noEmbeddings, logger: quiet, startDelayMs: 60_000 });
    expect(index?.status()).toMatchObject({ skipped: 0 });
    await index?.close();
  });

  it("leaves them skipped while it is off", async () => {
    await seedSkippedPhoto();
    const index = createRuntimeFileIndex({ config: runtimeConfig(false), notesStore: noEmbeddings, logger: quiet, startDelayMs: 60_000 });
    expect(index?.status()).toMatchObject({ skipped: 1 });
    await index?.close();
  });
});
