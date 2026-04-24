import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { LocalModelDef, LocalModelId } from "./models-catalog.js";
import { resolveModelDir, resolveModelFilePath } from "./backend-paths.js";
import { downloadFile, type DownloadProgressFn } from "./download-file.js";

export function isModelDownloaded(dataDir: string, model: LocalModelDef): boolean {
  return existsSync(resolveModelFilePath(dataDir, model.id, model.filename));
}

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

export function removeModel(dataDir: string, modelId: LocalModelId): void {
  rmSync(resolveModelDir(dataDir, modelId), { recursive: true, force: true });
}
