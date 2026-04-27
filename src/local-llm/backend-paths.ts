import { join } from "node:path";

export function resolveBackendDir(dataDir: string): string {
  return join(dataDir, "backend");
}

export function resolveModelsDir(dataDir: string): string {
  return join(dataDir, "models");
}

export function resolveServerBinPath(dataDir: string, binaryName: string): string {
  return join(resolveBackendDir(dataDir), binaryName);
}

export function resolveModelDir(dataDir: string, modelId: string): string {
  return join(resolveModelsDir(dataDir), modelId);
}

export function resolveModelFilePath(
  dataDir: string,
  modelId: string,
  filename: string,
): string {
  return join(resolveModelDir(dataDir, modelId), filename);
}

/**
 * Resolve the on-disk path for a model's mmproj projector file. The
 * projector lives in the same per-model directory as the GGUF weights so
 * removal of a model also removes its projector.
 */
export function resolveMmprojFilePath(
  dataDir: string,
  modelId: string,
  mmprojFilename: string,
): string {
  return join(resolveModelDir(dataDir, modelId), mmprojFilename);
}

export function resolveVersionFilePath(dataDir: string): string {
  return join(resolveBackendDir(dataDir), "backend-version.json");
}

export function resolvePidFilePath(dataDir: string): string {
  return join(dataDir, "llama-server.pid");
}

export function resolveLogFilePath(dataDir: string): string {
  return join(dataDir, "llama-server.log");
}
