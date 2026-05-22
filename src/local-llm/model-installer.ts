import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  EmbeddingModelDef,
  EmbeddingModelId,
  LocalModelDef,
  LocalModelId,
} from "./models-catalog.js";
import {
  resolveModelDir,
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "./backend-paths.js";
import { downloadFile, type DownloadProgressFn } from "./download-file.js";

export function isModelDownloaded(dataDir: string, model: LocalModelDef): boolean {
  return existsSync(resolveModelFilePath(dataDir, model.id, model.filename));
}

/**
 * True iff the model is vision-capable AND its mmproj projector file is
 * already present on disk. Returns `false` for non-vision models — the
 * caller should branch on `model.supportsVision` first when distinguishing
 * "n/a" from "missing".
 */
export function isMmprojDownloaded(
  dataDir: string,
  model: LocalModelDef,
): boolean {
  if (!model.supportsVision || !model.mmprojFilename) return false;
  return existsSync(
    resolveMmprojFilePath(dataDir, model.id, model.mmprojFilename),
  );
}

/**
 * Download the GGUF weights for `model`. Idempotent — returns immediately
 * if the destination file already exists. Does **not** touch the mmproj
 * projector; call `downloadMmproj` separately when the caller wants
 * multimodal support.
 */
export async function downloadModel(
  dataDir: string,
  model: LocalModelDef,
  opts?: { onProgress?: DownloadProgressFn; signal?: AbortSignal },
): Promise<void> {
  const dest = resolveModelFilePath(dataDir, model.id, model.filename);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  await downloadFile(model.huggingFaceUrl, dest, opts);
}

/**
 * Download the mmproj projector file for a vision-capable model.
 * Idempotent. Throws if the model is not vision-capable so callers
 * cannot accidentally request a projector for a text-only model.
 */
export async function downloadMmproj(
  dataDir: string,
  model: LocalModelDef,
  opts?: { onProgress?: DownloadProgressFn; signal?: AbortSignal },
): Promise<void> {
  if (!model.supportsVision || !model.mmprojUrl || !model.mmprojFilename) {
    throw new Error(
      `model ${model.id} is not vision-capable; cannot download mmproj`,
    );
  }
  const dest = resolveMmprojFilePath(dataDir, model.id, model.mmprojFilename);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  await downloadFile(model.mmprojUrl, dest, opts);
}

/**
 * Delete the on-disk directory for a model (GGUF + mmproj). Async so it
 * does not block the Ink event loop on multi-gigabyte models — `rmSync`
 * here used to freeze the TUI for several seconds on slower disks.
 */
export async function removeModel(
  dataDir: string,
  modelId: LocalModelId,
): Promise<void> {
  await rm(resolveModelDir(dataDir, modelId), {
    recursive: true,
    force: true,
  });
}

// ---------------------------------------------------------------------
// Memory-v2 phase 1B. Embedding model installer.
//
// Embedding GGUFs live in the **same** per-model directory layout as
// chat models — `<dataDir>/models/<id>/<filename>` — so existing CLI
// surface (path resolution, disk-usage probe in TUI, etc.) keeps
// working with the new ids. A separate `isEmbeddingModelDownloaded`
// is exposed mainly for symmetry with `isModelDownloaded`; structural
// duplication is justified by the typed-id wall (an `EmbeddingModelId`
// MUST NOT be passed where a `LocalModelId` is expected and vice
// versa — see `models-catalog.ts`).
// ---------------------------------------------------------------------

export function isEmbeddingModelDownloaded(
  dataDir: string,
  model: EmbeddingModelDef,
): boolean {
  return existsSync(resolveModelFilePath(dataDir, model.id, model.filename));
}

export async function downloadEmbeddingModel(
  dataDir: string,
  model: EmbeddingModelDef,
  opts?: { onProgress?: DownloadProgressFn; signal?: AbortSignal },
): Promise<void> {
  const dest = resolveModelFilePath(dataDir, model.id, model.filename);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  await downloadFile(model.huggingFaceUrl, dest, opts);
}

export async function removeEmbeddingModel(
  dataDir: string,
  modelId: EmbeddingModelId,
): Promise<void> {
  await rm(resolveModelDir(dataDir, modelId), {
    recursive: true,
    force: true,
  });
}
