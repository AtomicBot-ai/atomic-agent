import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

/**
 * A LoRA adapter the managed chat server applies on top of one model's
 * weights (ATO-1106), configured per model id under
 * `localModels.managed.loraAdapters`. `scale` defaults to llama.cpp's own
 * `1`; any other value launches with `--lora-scaled` instead of `--lora`.
 */
export interface LoraAdapter {
  /** Absolute path to the adapter's `.gguf` file. */
  path: string;
  scale?: number;
}

/**
 * What is wrong with an adapter's shape, or `null`. Pure: no disk access.
 * llama.cpp reads `--lora` as a comma-separated list and `--lora-scaled`
 * as `FNAME:SCALE,...`, so a comma anywhere, or a colon in a scaled
 * path (a Windows drive letter included), would be split into another
 * adapter or a broken pair; those are refused here instead.
 */
export function loraAdapterShapeProblem(
  adapter: LoraAdapter,
  pathIsAbsolute: (p: string) => boolean = isAbsolute,
): string | null {
  const { path, scale } = adapter;
  if (typeof path !== "string" || path.trim().length === 0) {
    return "expected a non-empty path to a .gguf adapter";
  }
  if (!pathIsAbsolute(path)) return `expected an absolute path, got ${JSON.stringify(path)}`;
  if (!path.toLowerCase().endsWith(".gguf")) return `expected a .gguf file, got ${JSON.stringify(path)}`;
  if (path.includes(",")) return "the adapter path cannot contain a comma (llama.cpp splits on it)";
  if (scale !== undefined) {
    if (typeof scale !== "number" || !Number.isFinite(scale)) {
      return `expected a finite number for scale, got ${JSON.stringify(scale)}`;
    }
    if (scale !== 1 && path.includes(":")) {
      return "a scaled adapter path cannot contain a colon (llama.cpp reads FNAME:SCALE); use scale 1 or move the file";
    }
  }
  return null;
}

/** Disk check for a launch: the adapter must be an existing regular file. */
export function loraAdapterFileProblem(
  adapter: LoraAdapter,
  isFile: (p: string) => boolean = defaultIsFile,
): string | null {
  return isFile(adapter.path) ? null : `LoRA adapter file not found: ${adapter.path}`;
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasCustomScale(adapter: LoraAdapter): adapter is LoraAdapter & { scale: number } {
  return adapter.scale !== undefined && adapter.scale !== 1;
}

/** The llama-server flags for an adapter; `[]` without one. */
export function loraAdapterArgs(adapter: LoraAdapter | undefined): string[] {
  if (!adapter) return [];
  return hasCustomScale(adapter)
    ? ["--lora-scaled", `${adapter.path}:${adapter.scale}`]
    : ["--lora", adapter.path];
}

/**
 * A stable identity for the adapter a launch carries, written to the
 * launch record so a running server launched with another adapter (or
 * none) is restarted rather than adopted. `null` means no adapter.
 */
export function loraAdapterKey(adapter: LoraAdapter | undefined): string | null {
  if (!adapter) return null;
  return hasCustomScale(adapter) ? `${adapter.path}:${adapter.scale}` : adapter.path;
}

/** The adapter configured for `modelId`, if any. */
export function loraAdapterForModel(
  adapters: Readonly<Record<string, LoraAdapter>> | undefined,
  modelId: string,
): LoraAdapter | undefined {
  if (!adapters || !Object.prototype.hasOwnProperty.call(adapters, modelId)) return undefined;
  return adapters[modelId];
}
