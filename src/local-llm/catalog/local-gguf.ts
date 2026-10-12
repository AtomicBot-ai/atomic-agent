/**
 * A GGUF the operator already has on disk, named by path instead of by
 * Hugging Face repo (issue #631). The file is registered where it is:
 * nothing is copied into `<dataDir>/models/`, nothing is downloaded, and
 * removing the model from the list never deletes it — the file belongs
 * to the operator, not to the managed model store.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
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
 * Validate a pasted path. Every failure throws a sentence meant for the
 * screen that asked for the reference.
 */
export function resolveLocalGgufFile(
  raw: string,
  opts?: { homeDir?: string },
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
