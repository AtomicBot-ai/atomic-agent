import { resolve } from "node:path";
import { statSnapshot } from "../skills/workspace-files.js";
import { instructionByteBudget, loadProjectInstructions, type ProjectInstructionOptions, type ProjectInstructionsResult } from "./project-instructions.js";

/**
 * Per-workspace cache in front of {@link loadProjectInstructions}. A cached result is
 * reused while every file it looked at keeps its stat signature, and for at most `ttlMs`,
 * after which discovery runs again (new nested files appear within that interval).
 */
export function createProjectInstructionsCache(cacheOptions: { ttlMs?: number; now?: () => number; load?: typeof loadProjectInstructions; maxEntries?: number } = {}) {
  const ttlMs = cacheOptions.ttlMs ?? 30_000;
  const now = cacheOptions.now ?? Date.now;
  const load = cacheOptions.load ?? loadProjectInstructions;
  const maxEntries = cacheOptions.maxEntries ?? 32;
  const entries = new Map<string, { result: ProjectInstructionsResult; signature: string; scannedAt: number }>();
  return (workingDir: string, signal?: AbortSignal, options: ProjectInstructionOptions = {}): ProjectInstructionsResult => {
    signal?.throwIfAborted();
    const key = `${resolve(workingDir)}\0${instructionByteBudget(options)}\0${options.maxFiles ?? ""}\0${options.allow ? options.allowKey ?? "?" : ""}`;
    const cached = entries.get(key);
    // An `allow` without a key cannot be compared, so it is never served from the cache.
    const cacheable = !options.allow || options.allowKey !== undefined;
    if (cacheable && cached && now() - cached.scannedAt < ttlMs && statSnapshot(cached.result.watched).signature === cached.signature) return cached.result;
    const result = load(workingDir, signal, options);
    entries.delete(key);
    entries.set(key, { result, signature: statSnapshot(result.watched).signature, scannedAt: now() });
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    return result;
  };
}
