import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { LocalModelDef, LocalModelId } from "./models-catalog.js";
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

export function removeModel(dataDir: string, modelId: LocalModelId): void {
  rmSync(resolveModelDir(dataDir, modelId), { recursive: true, force: true });
}
