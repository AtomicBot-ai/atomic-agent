/**
 * "If some model was downloaded before, it should just get picked up."
 *
 * Finds the GGUF models already on this computer, the way LM Studio, Jan and
 * Msty list what is in their folders before they offer a download: our own
 * model store (also the default `~/.atomic-agent` one when the app runs on
 * another state dir, the clean-profile case), LM Studio, the Hugging Face
 * cache, Jan and llama.cpp's `-hf` cache. Read only: nothing is copied or
 * moved. A file the person picks is registered where it lies, as a
 * `localPath` entry (local-gguf.ts, ATO-1402).
 *
 * Ollama is left out on purpose: its weights are content-addressed blobs
 * with no `.gguf` name, and the app already reaches Ollama itself as a
 * server (Custom › Ollama).
 *
 * Skipped: partial downloads (anything not ending in `.gguf`, and a `.gguf`
 * with a `.part` beside it), vision projectors (`mmproj`), embedding and
 * reranker models, shards other than the first (and a first shard whose
 * siblings are missing), files under 50 MB, files without the GGUF magic.
 *
 * Bounded: a depth per folder, a total entry budget, a model cap and a
 * deadline; every read is async, so the main process never blocks on it.
 *
 * No Electron import: the unit suite loads this from `out/main`.
 */

import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export type FoundSource = "atomic" | "lmstudio" | "huggingface" | "jan" | "llamacpp" | "other";

/** One model the scan found; the shape `discoverLocalModels()` answers with. */
export interface FoundModel {
  path: string;
  name: string;
  sizeBytes: number;
  source: FoundSource;
  quant?: string;
  registered: boolean;
}

/** What main keeps beside each answer (never sent to the window). */
export interface FoundModelMeta extends FoundModel {
  /** The catalogue id when `registered`. */
  modelId?: string;
  /** Lies inside the current managed store with no entry of its own (a lost config). */
  orphanInStore?: boolean;
}

export interface ScanRoot {
  dir: string;
  source: FoundSource;
  /** How deep below `dir` a .gguf may sit (1 = directly in it). */
  maxDepth: number;
}

export const MIN_MODEL_BYTES = 50 * 1024 * 1024;

export interface RootInputs {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** `<managed data dir>/models` of the state dir the app runs on. */
  managedModelsDir: string;
  /** `<managed data dir>/models` of the default `~/.atomic-agent`, when it is another folder. */
  defaultModelsDir?: string | null;
  /** The folder `~/.lmstudio-home-pointer` names, when that file exists (main reads it). */
  lmStudioHome?: string | null;
}

function abs(v: string | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t && isAbsolute(t) ? t : null;
}

/** The Hugging Face hub cache, as huggingface_hub resolves it. */
export function huggingFaceHubDir(env: Record<string, string | undefined>, home: string): string {
  const hub = abs(env["HF_HUB_CACHE"]) ?? abs(env["HUGGINGFACE_HUB_CACHE"]);
  if (hub) return hub;
  const hfHome = abs(env["HF_HOME"]);
  if (hfHome) return join(hfHome, "hub");
  const xdg = abs(env["XDG_CACHE_HOME"]);
  return join(xdg ?? join(home, ".cache"), "huggingface", "hub");
}

/** llama.cpp's `-hf` download cache (common/common.cpp fs_get_cache_directory). */
export function llamaCppCacheDir(env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform): string {
  const own = abs(env["LLAMA_CACHE"]);
  if (own) return own;
  if (platform === "darwin") return join(home, "Library", "Caches", "llama.cpp");
  if (platform === "win32") return join(abs(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local"), "llama.cpp");
  return join(abs(env["XDG_CACHE_HOME"]) ?? join(home, ".cache"), "llama.cpp");
}

/** Every folder the scan looks in, in priority order (a file found twice keeps the first). */
export function scanRoots(i: RootInputs): ScanRoot[] {
  const { home, platform, env } = i;
  const roots: ScanRoot[] = [{ dir: i.managedModelsDir, source: "atomic", maxDepth: 2 }];
  if (i.defaultModelsDir && i.defaultModelsDir !== i.managedModelsDir) {
    roots.push({ dir: i.defaultModelsDir, source: "atomic", maxDepth: 2 });
  }
  // LM Studio: <home>/models/<publisher>/<repo>/<file>.gguf; the pointer file moves <home>.
  if (i.lmStudioHome) roots.push({ dir: join(i.lmStudioHome, "models"), source: "lmstudio", maxDepth: 4 });
  roots.push({ dir: join(home, ".lmstudio", "models"), source: "lmstudio", maxDepth: 4 });
  roots.push({ dir: join(home, ".cache", "lm-studio", "models"), source: "lmstudio", maxDepth: 4 });
  // Hugging Face: hub/models--<owner>--<repo>/snapshots/<rev>/[<sub>/]<file>.gguf
  roots.push({ dir: huggingFaceHubDir(env, home), source: "huggingface", maxDepth: 6 });
  // Jan: the legacy ~/jan/models/<id>/model.gguf, and the app data folder (data/models, data/llamacpp/models).
  roots.push({ dir: join(home, "jan", "models"), source: "jan", maxDepth: 4 });
  const janData =
    platform === "darwin" ? join(home, "Library", "Application Support", "Jan", "data")
      : platform === "win32" ? join(abs(env["APPDATA"]) ?? join(home, "AppData", "Roaming"), "Jan", "data")
        : join(abs(env["XDG_CONFIG_HOME"]) ?? join(home, ".config"), "Jan", "data");
  roots.push({ dir: join(janData, "models"), source: "jan", maxDepth: 4 });
  roots.push({ dir: join(janData, "llamacpp", "models"), source: "jan", maxDepth: 4 });
  roots.push({ dir: llamaCppCacheDir(env, home, platform), source: "llamacpp", maxDepth: 2 });
  return roots;
}

/* ------------------------------------------------------------ names --- */

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/** `{ base, index, count }` for `name-00001-of-00003.gguf`, else null. */
export function shardOf(file: string): { base: string; index: number; count: number } | null {
  const m = SHARD_RE.exec(file);
  if (!m) return null;
  const index = Number(m[2]);
  const count = Number(m[3]);
  return count >= 1 && index >= 1 && index <= count ? { base: m[1]!, index, count } : null;
}

/** The skip rules that a file name alone decides. */
export function skipByName(file: string): boolean {
  if (!/\.gguf$/i.test(file)) return true;       // .part, .download, .incomplete…
  if (file.startsWith(".")) return true;          // hidden, and refused by the config schema
  if (file.includes("\\")) return true;
  if (/mmproj/i.test(file)) return true;          // a vision projector, not a model
  if (/embed|rerank/i.test(file)) return true;   // not a chat model (the embedding catalogue is its own list)
  const shard = shardOf(file);
  if (shard && shard.index !== 1) return true;    // llama.cpp loads the rest from the first
  return false;
}

const QUANT_RE = /(?:^|[-_.])(I?Q[1-8](?:_[0-9A-Z]{1,4}){0,3}|BF16|F16|FP16|F32|MXFP4)(?=$|[-_.])/gi;

/** The quantisation a file name carries ("Q4_K_M", "IQ2_XXS", "BF16"), else undefined. */
export function quantOf(file: string): string | undefined {
  const stem = file.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  let last: string | undefined;
  for (const m of stem.matchAll(QUANT_RE)) last = m[1];
  return last ? last.toUpperCase() : undefined;
}

const GENERIC_STEMS = new Set(["model", "ggml-model", "weights", "main"]);

/** What a person reads: the file stem without the shard suffix; the folder's name for a bare `model.gguf` (Jan). */
export function displayName(path: string): string {
  const stem = basename(path).replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "");
  if (GENERIC_STEMS.has(stem.toLowerCase())) {
    const parent = basename(dirname(path));
    if (parent) return parent;
  }
  return stem;
}

/* ----------------------------------------------------- registration --- */

export interface Registry {
  managedModelsDir: string;
  /** `localModels.customModels` as the config holds it. */
  customModels: Array<{ id?: unknown; localPath?: unknown; filename?: unknown; name?: unknown }>;
  /** Whether `id` is a curated catalogue id (model-catalog.ts curatedMeta). */
  isCatalogId: (id: string) => boolean;
  /** The catalogue's human name for an id, when it has one. */
  catalogName?: (id: string) => string | null;
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether the app already knows this file, and as which model:
 *   - a `localPath` entry naming it (or its real path);
 *   - `<managed>/<id>/<file>` with a custom entry of that id and filename;
 *   - `<managed>/<id>/<file>` where `id` is a curated catalogue id.
 * A file inside the store that matches none of those is an orphan: its
 * entry was lost (a fresh config pointed at the same store).
 */
export function registrationOf(
  path: string,
  real: string,
  reg: Registry,
  /** Real paths of the store and of every `localPath`, when the caller resolved them (scanLocalModels does). */
  resolved?: { storeDirs?: string[]; localPaths?: Map<string, string> },
): { registered: boolean; modelId?: string; name?: string; orphanInStore?: boolean } {
  for (const m of reg.customModels) {
    if (!m || typeof m.id !== "string" || typeof m.localPath !== "string") continue;
    const lp = m.localPath;
    if (lp === path || lp === real || resolved?.localPaths?.get(lp) === real) return { registered: true, modelId: m.id };
  }
  const stores = resolved?.storeDirs ?? [reg.managedModelsDir];
  let rel: string | null = null;
  for (const store of stores) {
    if (isInside(path, store)) { rel = relative(store, path); break; }
    if (isInside(real, store)) { rel = relative(store, real); break; }
  }
  if (rel === null) return { registered: false };
  const parts = rel.split(sep);
  if (parts.length === 2) {
    const [id, file] = parts as [string, string];
    const custom = reg.customModels.find((m) => m && m.id === id && typeof m.localPath !== "string");
    if (custom && (custom.filename === undefined || custom.filename === file)) {
      return { registered: true, modelId: id, name: typeof custom.name === "string" ? custom.name : undefined };
    }
    if (!id.startsWith("custom-") && reg.isCatalogId(id)) {
      return { registered: true, modelId: id, name: reg.catalogName?.(id) ?? undefined };
    }
  }
  return { registered: false, orphanInStore: true };
}

/* ------------------------------------------------------------- scan --- */

export interface ScanLimits {
  deadlineMs: number;
  maxEntries: number;
  maxModels: number;
  minBytes: number;
}

export const DEFAULT_LIMITS: ScanLimits = { deadlineMs: 4000, maxEntries: 20000, maxModels: 200, minBytes: MIN_MODEL_BYTES };

async function hasGgufMagic(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.toString("latin1") === "GGUF";
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

const SKIP_DIRS = new Set(["node_modules", "blobs", "refs", ".no_exist"]);

/**
 * Walk `roots` and answer every usable model, deduplicated by real path.
 * `reg` marks what is already registered; without it nothing is.
 */
export async function scanLocalModels(
  roots: ScanRoot[],
  reg: Registry | null,
  limits: Partial<ScanLimits> = {},
  now: () => number = Date.now,
): Promise<{ models: FoundModelMeta[]; truncated: boolean }> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const until = now() + lim.deadlineMs;
  let entries = 0;
  let truncated = false;
  const seen = new Set<string>();
  const out: FoundModelMeta[] = [];
  // Symlinks on either side (macOS /var → /private/var, a store moved by a link) must still match.
  const resolved: { storeDirs: string[]; localPaths: Map<string, string> } = { storeDirs: [], localPaths: new Map() };
  if (reg) {
    resolved.storeDirs.push(reg.managedModelsDir);
    try {
      const r = await realpath(reg.managedModelsDir);
      if (r !== reg.managedModelsDir) resolved.storeDirs.push(r);
    } catch { /* no store yet */ }
    for (const m of reg.customModels) {
      if (!m || typeof m.localPath !== "string") continue;
      try { resolved.localPaths.set(m.localPath, await realpath(m.localPath)); } catch { /* the file is gone */ }
    }
  }
  const outOfBudget = () => {
    if (entries >= lim.maxEntries || now() > until || out.length >= lim.maxModels) truncated = true;
    return truncated;
  };

  const consider = async (dir: string, file: string, names: Set<string>, source: FoundSource) => {
    if (skipByName(file)) return;
    if (names.has(`${file}.part`)) return;   // still downloading in place
    const path = join(dir, file);
    let size = 0;
    try {
      const st = await stat(path);   // follows the Hugging Face snapshot symlinks to their blobs
      if (!st.isFile()) return;
      size = st.size;
    } catch {
      return;
    }
    const shard = shardOf(file);
    if (shard) {
      // Every sibling must be there, else it is a half-finished download.
      for (let k = 2; k <= shard.count; k++) {
        const sib = `${shard.base}-${String(k).padStart(5, "0")}-of-${String(shard.count).padStart(5, "0")}.gguf`;
        if (!names.has(sib)) return;
        try { size += (await stat(join(dir, sib))).size; } catch { return; }
      }
    }
    if (size < lim.minBytes) return;
    let real = path;
    try { real = await realpath(path); } catch { /* the path itself */ }
    if (seen.has(real)) return;
    if (!(await hasGgufMagic(path))) return;
    seen.add(real);
    const r: ReturnType<typeof registrationOf> = reg ? registrationOf(path, real, reg, resolved) : { registered: false };
    const quant = quantOf(file);
    out.push({
      path,
      name: r.name || displayName(path),
      sizeBytes: size,
      source,
      ...(quant ? { quant } : {}),
      registered: r.registered,
      ...(r.modelId ? { modelId: r.modelId } : {}),
      ...(r.orphanInStore ? { orphanInStore: true } : {}),
    });
  };

  const walk = async (dir: string, depth: number, root: ScanRoot): Promise<void> => {
    if (outOfBudget()) return;
    let list;
    try {
      list = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries += list.length;
    const names = new Set(list.map((d) => d.name));
    const subdirs: string[] = [];
    for (const d of list) {
      if (outOfBudget()) return;
      if (d.isDirectory()) {
        // Directory symlinks are not followed: no loops, no walking off the root.
        if (depth < root.maxDepth && !d.name.startsWith(".") && !SKIP_DIRS.has(d.name)) subdirs.push(d.name);
        continue;
      }
      if (d.isFile() || d.isSymbolicLink()) await consider(dir, d.name, names, root.source);
    }
    for (const s of subdirs) await walk(join(dir, s), depth + 1, root);
  };

  for (const root of roots) {
    if (outOfBudget()) break;
    // Walked by the name the app knows it under (a linked ~/.lmstudio stays ~/.lmstudio).
    try { if (!(await stat(root.dir)).isDirectory()) continue; } catch { continue; }   // missing: nothing there
    await walk(root.dir, 1, root);
  }
  return { models: out, truncated };
}

/** The window's view of a scan: no ids, no store flags. */
export function publicModels(models: FoundModelMeta[]): FoundModel[] {
  return models.map(({ path, name, sizeBytes, source, quant, registered }) => ({
    path, name, sizeBytes, source, ...(quant ? { quant } : {}), registered,
  }));
}

/* ------------------------------------------------------------ guard --- */

/* The last scan's answers, by path. `useLocalModel` takes only these (the
   plugins-ipc wasPickedFolder pattern): a path the window made up, or one a
   newer scan no longer found, is refused. */
const discovered = new Map<string, FoundModelMeta>();

export function rememberDiscovered(models: FoundModelMeta[]): void {
  discovered.clear();
  for (const m of models) discovered.set(m.path, m);
}

export function discoveredModel(p: unknown): FoundModelMeta | null {
  return typeof p === "string" ? discovered.get(p) ?? null : null;
}
