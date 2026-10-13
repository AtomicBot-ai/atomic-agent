/**
 * A GGUF the operator already has on disk, named by path instead of by
 * Hugging Face repo (issue #631). The file is registered where it is:
 * nothing is copied into `<dataDir>/models/`, nothing is downloaded, and
 * removing the model from the list never deletes it — the file belongs
 * to the operator, not to the managed model store.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatGgufSize, ggufSizeGb } from "./huggingface-model-def.js";
import type { LocalModelDef, LocalModelId } from "./models-catalog.js";

/** A validated, readable `.gguf` on local disk. */
export interface LocalGgufFile {
  /** Absolute, normalized path. */
  path: string;
  sizeBytes: number;
}

/**
 * Strip one pair of matching quotes. Terminals and file managers quote a
 * dragged-in path that contains spaces, and that is what gets pasted.
 */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const first = trimmed[0];
  if (
    trimmed.length >= 2 &&
    (first === `"` || first === `'`) &&
    trimmed[trimmed.length - 1] === first
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHome(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${homeDir}${path.slice(1)}`;
  }
  return path;
}

/**
 * Whether a reference names a local file rather than a Hugging Face repo:
 * an absolute POSIX path, a `~/` path, or a Windows drive/UNC path.
 * Narrow on purpose — `owner/name` and every URL form still go to the
 * Hugging Face parser, which owns their error messages.
 */
export function looksLikeLocalGgufPath(raw: string): boolean {
  const ref = unquote(raw);
  if (ref.length === 0) return false;
  if (ref === "~" || ref.startsWith("~/") || ref.startsWith("~\\")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(ref) || ref.startsWith("\\\\")) return true;
  return ref.startsWith("/");
}

/**
 * What a screen says about a model added from disk whose file is gone.
 * There is nothing to download, so no "press Enter to download" — only
 * where the file was expected and how to point at it again.
 */
export function describeMissingLocalGguf(path: string): string {
  return `local file is missing at ${path} — it was added from disk, so there is nothing to download; add it again by its path from Models (/local)`;
}

/** Message for a file inside the managed store (see `resolveLocalGgufFile`). */
export const MANAGED_GGUF_PATH_ERROR =
  "That file belongs to a model Atomic Agent already manages; pick it from the list instead.";

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `path` is `dir` itself or lies anywhere beneath it. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate a pasted path. Every failure throws a sentence meant for the
 * screen that asked for the reference.
 *
 * `managedModelsDir` is `<dataDir>/models/`: a file in there already
 * belongs to a curated or Hugging Face entry, and removing that entry
 * deletes its directory — the file a local entry pointed at with it.
 * Compared after resolving symlinks on both sides, so a link into the
 * store is caught too.
 */
export function resolveLocalGgufFile(
  raw: string,
  opts?: { homeDir?: string; managedModelsDir?: string },
): LocalGgufFile {
  const ref = expandHome(unquote(raw), opts?.homeDir ?? homedir());
  if (!isAbsolute(ref)) {
    throw new Error(
      `Use an absolute path to a .gguf file: ${JSON.stringify(raw.trim())}`,
    );
  }
  const path = resolve(ref);
  if (!/\.gguf$/i.test(path)) {
    throw new Error(`Not a .gguf file: ${path}`);
  }
  // The stored entry keeps the bare filename, and the config refuses a
  // name that starts with a dot or carries a backslash (it would be
  // read as a path). Say so here, in words, rather than let the save
  // fail with a config-validation message.
  const name = basename(path);
  if (name.startsWith(".")) {
    throw new Error(
      `File names starting with a dot are not supported: ${name}. Rename the file and try again.`,
    );
  }
  if (name.includes("\\")) {
    throw new Error(
      `File names containing a backslash are not supported: ${name}. Rename the file and try again.`,
    );
  }
  let stat: Stats;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`No such file: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${path}`);
  }
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

/**
 * `custom-local-<file stem>-<hash of the path>`. The hash keeps two
 * files with the same name in different folders apart, and re-adding the
 * same path refreshes its entry instead of duplicating it.
 */
export function buildLocalGgufModelId(path: string): LocalModelId {
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

/**
 * Catalog entry for a file on disk. `localPath` is what the managed
 * server launches; `huggingFaceUrl` carries the matching `file://` URL
 * only because the stored entry needs a valid URL there — it is never
 * fetched (`downloadModel` refuses local entries). RAM figures use the
 * same advisory estimate as `buildCustomModelDef`.
 */
export function buildLocalGgufModelDef(file: LocalGgufFile): LocalModelDef {
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
