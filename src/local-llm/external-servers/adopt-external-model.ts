/**
 * "Use in Atomic Agent": run a model that Ollama or LM Studio already
 * downloaded on our own managed engine, without downloading it again
 * (ATO-2490). Gollama's link of Ollama models into LM Studio and LM Studio's
 * own "import a model file" are the precedent.
 *
 * - LM Studio keeps plain `.gguf` files: the file is registered where it
 *   lies, as "Use a .gguf file I already have" does (local-gguf.ts).
 * - Ollama keeps the GGUF as a blob without an extension
 *   (`blobs/sha256-…`), so it is linked into `<dataDir>/linked-models/` as
 *   `ollama-<name>.gguf` and that link is registered. A hard link first: no
 *   second copy on disk, and `ollama rm` later does not break it. A symbolic
 *   link when the two folders are on different disks; a copy only when asked.
 *
 * Refused, in words: a blob that is not GGUF (Ollama's own newer formats),
 * and a GGUF with no chat template inside, which would be served with the
 * wrong prompt format (Ollama keeps its template in a separate layer).
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  symlinkSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { basename, join, relative } from "node:path";

import { readGgufMetadata } from "../catalog/gguf-metadata.js";
import { buildLocalGgufModelDef, resolveLocalGgufFile } from "../catalog/local-gguf.js";
import type { LocalModelDef } from "../catalog/models-catalog.js";
import { currentHost, lmstudioModelsDirs, lmstudioSettingsFile, ollamaModelsDirs, type HostPaths } from "./external-server-paths.js";
import { lmsList, type LmsOptions } from "./lmstudio-cli.js";
import { ollamaModelBlobPath, type OllamaCallOptions } from "./ollama-control.js";

export type LinkHow = "hardlink" | "symlink" | "copy" | "in-place";

export interface AdoptResult {
  readonly def: LocalModelDef;
  /** The file the other app keeps. */
  readonly sourcePath: string;
  /** What our engine opens: the link, or the source itself for LM Studio. */
  readonly path: string;
  readonly how: LinkHow;
}

export interface AdoptOptions {
  /** `<dataDir>` of the managed engine (`paths.localModelsDataDir`). */
  readonly dataDir: string;
  /** `<dataDir>/models` or its override; a link must not land inside it. */
  readonly managedModelsDir: string;
  /** Copy when a link cannot be made (different disks on Windows). */
  readonly copy?: boolean;
  readonly host?: HostPaths;
  readonly ollama?: OllamaCallOptions;
  readonly lms?: LmsOptions;
}

export const LINKED_MODELS_DIR = "linked-models";

/** `ollama-qwen3-8b.gguf` from `qwen3:8b`. */
export function linkedFileName(source: "ollama", model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 80);
  return `${source}-${slug || "model"}.gguf`;
}

/** Where Ollama's manifest for `name` is, under one models folder. */
export function ollamaManifestPath(modelsDir: string, name: string): string {
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const tag = colon > slash ? name.slice(colon + 1) : "latest";
  const repo = colon > slash ? name.slice(0, colon) : name;
  const parts = repo.split("/");
  const hasHost = parts.length > 1 && /[.:]/.test(parts[0]!);
  const host = hasHost ? parts.shift()! : "registry.ollama.ai";
  if (parts.length === 1) parts.unshift("library");
  return join(modelsDir, "manifests", host, ...parts, tag);
}

/** The weights blob named in a manifest, or null. */
export function modelBlobFromManifest(modelsDir: string, manifestJson: string): string | null {
  try {
    const body = JSON.parse(manifestJson) as { layers?: Array<{ mediaType?: unknown; digest?: unknown }> };
    const layer = (body.layers ?? []).find((l) => l && l.mediaType === "application/vnd.ollama.image.model");
    const digest = layer && typeof layer.digest === "string" ? layer.digest : null;
    return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? join(modelsDir, "blobs", digest.replace(":", "-")) : null;
  } catch {
    return null;
  }
}

/** The blob, asked of the running Ollama first, else read from its manifests on disk. */
export async function findOllamaBlob(model: string, opts: AdoptOptions): Promise<string> {
  const asked = await ollamaModelBlobPath(model, opts.ollama ?? {}).catch(() => null);
  if (asked && existsSync(asked)) return asked;
  for (const dir of ollamaModelsDirs(opts.host ?? currentHost())) {
    const manifest = ollamaManifestPath(dir, model);
    if (!existsSync(manifest)) continue;
    const blob = modelBlobFromManifest(dir, readFileSync(manifest, "utf8"));
    if (blob && existsSync(blob)) return blob;
  }
  throw new Error(`Could not find the file of ${model} in Ollama's models folder.`);
}

function startsWithGguf(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && head.toString("latin1") === "GGUF";
  } finally {
    closeSync(fd);
  }
}

/** Refuse what our engine cannot serve right. Throws a sentence. */
export async function checkServableGguf(path: string, label: string): Promise<void> {
  if (!startsWithGguf(path)) {
    throw new Error(`${label} is not stored as a GGUF file, so the local engine cannot run it. Keep using it through its app.`);
  }
  const meta = await readGgufMetadata(path).catch(() => null);
  if (meta && !meta.truncated && typeof meta.keys["tokenizer.chat_template"] !== "string") {
    throw new Error(`${label} has no chat template inside its file, so it would answer in the wrong format here. Keep using it through its app.`);
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.size === sb.size;
  } catch {
    return false;
  }
}

/** Link (or copy) `source` to `dest`. Returns how. Throws a sentence. */
export function linkModelFile(source: string, dest: string, copy: boolean): LinkHow {
  if (existsSync(dest)) {
    if (sameFile(source, dest)) return "hardlink";
    unlinkSync(dest);
  }
  try {
    linkSync(source, dest);
    return "hardlink";
  } catch {
    // Different disks (EXDEV) or a file system without hard links.
  }
  try {
    symlinkSync(source, dest, "file");
    return "symlink";
  } catch {
    // Windows without the symlink right.
  }
  if (copy) {
    copyFileSync(source, dest);
    return "copy";
  }
  const gb = (statSync(source).size / 1e9).toFixed(1);
  throw new Error(`Could not link the model file into Atomic Agent's folder (it is on another disk). Copying it would take ${gb} GB; run again with --copy to do that.`);
}

/** An LM Studio model's `.gguf`: from `lms ls --json`, else the first matching file in its models folders. */
export async function findLmStudioFile(key: string, opts: AdoptOptions): Promise<string> {
  const host = opts.host ?? currentHost();
  let folder: string | null = null;
  try {
    const settings = JSON.parse(readFileSync(lmstudioSettingsFile(host), "utf8")) as { downloadsFolder?: unknown };
    if (typeof settings.downloadsFolder === "string") folder = settings.downloadsFolder;
  } catch {
    // no settings file: the default folders
  }
  const dirs = lmstudioModelsDirs(host, folder).filter((d) => existsSync(d));
  const listed = await lmsList(dirs[0] ?? null, opts.lms ?? {}).catch(() => []);
  const hit = listed.find((m) => m.modelKey === key && m.path && /\.gguf$/i.test(m.path) && existsSync(m.path));
  if (hit && hit.path) return hit.path;
  const want = key.split("/").pop()!.split("@")[0]!.toLowerCase();
  for (const dir of dirs) {
    const found = ggufFilesUnder(dir, 4).filter((f) => relative(dir, f).toLowerCase().includes(want)).sort();
    if (found[0]) return found[0];
  }
  throw new Error(`Could not find the file of ${key} in LM Studio's models folder.`);
}

/** `.gguf` files under `dir`, `depth` folders down, projectors left out. */
export function ggufFilesUnder(dir: string, depth: number): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...ggufFilesUnder(p, depth - 1));
    else if (e.isFile() && /\.gguf$/i.test(e.name) && !/^mmproj/i.test(e.name)) out.push(p);
  }
  return out;
}

/** Find, check, link and build the catalog entry. The caller saves it (`addCustomModel`). */
export async function adoptExternalModel(
  kind: "ollama" | "lmstudio",
  model: string,
  opts: AdoptOptions,
): Promise<AdoptResult> {
  const app = kind === "ollama" ? "Ollama" : "LM Studio";
  const source = kind === "ollama" ? await findOllamaBlob(model, opts) : await findLmStudioFile(model, opts);
  await checkServableGguf(source, `${model} from ${app}`);
  let path = source;
  let how: LinkHow = "in-place";
  if (kind === "ollama") {
    const dir = join(opts.dataDir, LINKED_MODELS_DIR);
    mkdirSync(dir, { recursive: true });
    path = join(dir, linkedFileName("ollama", model));
    how = linkModelFile(source, path, opts.copy === true);
  }
  const def = buildLocalGgufModelDef(resolveLocalGgufFile(path, { managedModelsDir: opts.managedModelsDir }));
  return {
    def: { ...def, name: `${model} (from ${app})`, description: `${app} model ${model}: ${source}` },
    sourcePath: source,
    path,
    how,
  };
}

/** One line for the terminal about where the file is now. */
export function describeAdoption(r: AdoptResult): string {
  if (r.how === "in-place") return `uses ${basename(r.path)} where LM Studio keeps it`;
  if (r.how === "copy") return `copied to ${r.path}`;
  return `${r.how === "hardlink" ? "linked" : "linked (symbolic link)"} at ${r.path}, no second copy on disk`;
}
