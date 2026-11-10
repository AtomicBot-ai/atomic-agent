/**
 * ATO-1402: a GGUF the person already has on disk, added from the desktop
 * without a download. The file is registered where it lies (`localPath`):
 * nothing is copied into `<dataDir>/models/`, and removing the model from
 * the list never deletes it.
 *
 * A copy of src/local-llm/catalog/local-gguf.ts (resolveLocalGgufFile,
 * buildLocalGgufModelId, buildLocalGgufModelDef), for the same reason
 * huggingface.ts is a copy: desktop/tsconfig.json compiles CommonJS from
 * main/** and preload/** only, and src/ is ESM. The entry it builds is the
 * one the TUI writes for a pasted path (issue #631), so `atag models pull`
 * finds the weights present and goes straight to activate-and-start
 * (model-installer.ts returns early for a `localPath` that exists).
 *
 * When local-gguf.ts changes, re-sync this file.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatGgufSize, ggufSizeGb } from "./huggingface.js";

export interface LocalGgufFile {
  path: string;
  sizeBytes: number;
}

/** Message for a file inside the managed store (local-gguf.ts MANAGED_GGUF_PATH_ERROR). */
export const MANAGED_GGUF_PATH_ERROR =
  "That file belongs to a model Atomic Agent already manages; pick it from the list instead.";

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** resolveLocalGgufFile, for a path a file dialog returned. Throws a sentence for the screen. */
export function resolveLocalGgufFile(raw: string, opts?: { managedModelsDir?: string }): LocalGgufFile {
  if (!isAbsolute(raw)) throw new Error(`Use an absolute path to a .gguf file: ${JSON.stringify(raw.trim())}`);
  const path = resolve(raw);
  if (!/\.gguf$/i.test(path)) throw new Error(`Not a .gguf file: ${path}`);
  const name = basename(path);
  if (name.startsWith(".")) {
    throw new Error(`File names starting with a dot are not supported: ${name}. Rename the file and try again.`);
  }
  if (name.includes("\\")) {
    throw new Error(`File names containing a backslash are not supported: ${name}. Rename the file and try again.`);
  }
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new Error(`Cannot read ${path} (permission denied)`);
  }
  if (
    opts?.managedModelsDir !== undefined &&
    existsSync(opts.managedModelsDir) &&
    isInside(realOrResolved(path), realOrResolved(opts.managedModelsDir))
  ) {
    throw new Error(MANAGED_GGUF_PATH_ERROR);
  }
  return { path, sizeBytes: stat.size };
}

/** `custom-local-<file stem>-<hash of the path>` (buildLocalGgufModelId). */
export function buildLocalGgufModelId(path: string): string {
  const stem = basename(path)
    .replace(/\.gguf$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60);
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `custom-local-${stem ? `${stem}-` : ""}${hash}`;
}

/** The `localModels.customModels` entry for a file on disk (buildLocalGgufModelDef). */
export function buildLocalGgufModelDef(file: LocalGgufFile): Record<string, unknown> & { id: string; name: string } {
  const fileSizeGb = ggufSizeGb(file.sizeBytes);
  const filename = basename(file.path);
  return {
    id: buildLocalGgufModelId(file.path),
    name: `${filename} (local file)`,
    filename,
    huggingFaceUrl: pathToFileURL(file.path).href,
    localPath: file.path,
    fileSizeGb,
    sizeLabel: formatGgufSize(file.sizeBytes),
    description: `Local file: ${file.path}`,
    maxContextLength: 0,
    contextLabel: "auto",
    minRamGb: Math.max(1, Math.ceil(fileSizeGb * 1.2)),
    recommendedRamGb: Math.max(2, Math.ceil(fileSizeGb * 1.5) + 2),
    family: "custom",
    supportsVision: false,
  };
}
