import { existsSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  listLocalModels,
  type EmbeddingModelDef,
  type EmbeddingModelId,
  type LocalModelDef,
  type LocalModelId,
} from "../catalog/models-catalog.js";
import {
  resolveChatModelWeightsPath,
  resolveModelDir,
  resolveModelFilePath,
  resolveMmprojFilePath,
} from "../backend-paths.js";
import { downloadFile, type DownloadFileOptions } from "./download-file.js";

/** What a model pull lets its caller steer: progress, retry notices, cancel. */
export type ModelDownloadOptions = Pick<
  DownloadFileOptions,
  "onProgress" | "onRetry" | "signal"
>;

export function isModelDownloaded(
  dataDir: string,
  model: LocalModelDef,
): boolean {
  return existsSync(resolveChatModelWeightsPath(dataDir, model));
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
 * A `file:` URL names a file on this machine, which no download can
 * fetch. It reaches here only from an entry that lost its `localPath`
 * and could not get it back from the URL (see `custom-models-schema.ts`);
 * say what to do instead of letting `fetch` fail with a transport error.
 */
function refuseFileUrl(model: LocalModelDef, url: string): void {
  if (!url.startsWith("file:")) return;
  throw new Error(
    `${model.name} points at a file on this machine (${url}), which cannot be downloaded; add the .gguf again by its path`,
  );
}

/**
 * Download the GGUF weights for `model`. Idempotent — returns immediately
 * if the destination file already exists. Does **not** touch the mmproj
 * projector; call `downloadMmproj` separately when the caller wants
 * multimodal support. A model registered from disk (`localPath`) is
 * never downloaded: its file is there, or the error says it moved.
 */
export async function downloadModel(
  dataDir: string,
  model: LocalModelDef,
  opts?: ModelDownloadOptions,
): Promise<void> {
  if (model.localPath) {
    if (existsSync(model.localPath)) return;
    throw new Error(
      `local model file not found: ${model.localPath} (it was added from disk, so there is nothing to download)`,
    );
  }
  const dest = resolveModelFilePath(dataDir, model.id, model.filename);
  if (existsSync(dest)) return;
  refuseFileUrl(model, model.huggingFaceUrl);
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
  opts?: ModelDownloadOptions,
): Promise<void> {
  if (!model.supportsVision || !model.mmprojUrl || !model.mmprojFilename) {
    throw new Error(
      `model ${model.id} is not vision-capable; cannot download mmproj`,
    );
  }
  const dest = resolveMmprojFilePath(dataDir, model.id, model.mmprojFilename);
  if (existsSync(dest)) return;
  refuseFileUrl(model, model.mmprojUrl);
  mkdirSync(dirname(dest), { recursive: true });
  await downloadFile(model.mmprojUrl, dest, opts);
}

/**
 * Delete the on-disk directory for a model (GGUF + mmproj). Async so it
 * does not block the Ink event loop on multi-gigabyte models — `rmSync`
 * here used to freeze the TUI for several seconds on slower disks.
 *
 * A model registered from disk (`localPath`) owns no files: the GGUF is
 * the operator's, so this deletes nothing and the caller only drops the
 * catalog entry.
 */
export async function removeModel(
  dataDir: string,
  modelId: LocalModelId,
): Promise<void> {
  const def = listLocalModels().find((m) => m.id === modelId);
  if (def?.localPath) return;
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
  opts?: ModelDownloadOptions,
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
