/**
 * Studio: local diffusion models on disk. What a family and one of its
 * quants need, what is already here, whether it fits this machine, what
 * removing it frees, and the load request Core takes. Pure but for
 * `listModelFiles` (a read-only walk); no Electron, so the unit suite
 * loads it from `out/main`.
 *
 * Port of Atomic Chat's web-app/src/lib/diffusion/models.ts (plan, list,
 * delete, buildLoadRequest) and fit.ts (fit verdict, offload policy), over
 * the same conf file, AtomicBot-ai/atomic-chat-conf models/diffusion.json
 * (schema_version 1).
 *
 * Layout, the one Atomic Chat writes and Core lists (atomic-chat-core
 * v0.18.6 src/diffusion/install.ts `listModelFiles`): a quant's transformer
 * at `<modelsRoot>/<family>/<file>`, its side files (VAE, text encoders) at
 * `<modelsRoot>/shared/<owner>--<repo>/<file>`, so a side file several
 * families use (the VAE Z-Image shares with every FLUX.1 family, the
 * FLUX.1 text encoders) is fetched once. Core does not download
 * model files (its ADR 2026-10-15-core-does-not-download-models); it takes
 * absolute paths at `POST /diffusion/model/load` and checks only that each
 * is a file.
 *
 * Our models root is `<managed data dir>/diffusion/models`, not Core's own
 * `<core data>/diffusion/models`: Core's data folder is per Core version
 * (`core/versions/<v>/data`), and a pin bump must not orphan 5–26 GB.
 *
 * Every path comes from the catalog, a file fetched from GitHub, so every
 * repo, file name and family id is checked before it becomes a path, and
 * the result is checked again to lie inside the models root.
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/* ------------------------------------------------------------ catalog */

export type DiffusionModality = "image" | "video";
export type OffloadPolicy = "none" | "group" | "model";

/** The text-encoder slots Core's `DiffusionModelFiles` has (src/contracts/diffusion.ts). */
const ENCODER_FIELDS = ["llm", "llm_vision", "qwen2vl", "clip_l", "t5xxl", "embeddings_connectors"] as const;
export type EncoderField = (typeof ENCODER_FIELDS)[number];

export interface DiffusionFile { repo: string; filename: string; bytes: number; sha256: string | null; field: EncoderField | null }
export interface DiffusionQuant { id: string; label: string; filename: string; bytes: number; sha256: string | null; recommended: boolean }

export interface DiffusionFamily {
  id: string;
  name: string;
  developer: string | null;
  modality: DiffusionModality;
  description: string | null;
  license: string | null;
  /** The Hugging Face repo needs an accepted licence and a token (Krea 2). */
  gated: boolean;
  repo: string;
  quants: DiffusionQuant[];
  vae: DiffusionFile | null;
  vaeFormat: string | null;
  audioVae: DiffusionFile | null;
  textEncoders: DiffusionFile[];
  defaults: { steps: number; cfgScale: number; guidance?: number; samplingMethod?: string; flowShift?: number; width: number; height: number; sigmas?: number[] };
  ranges: { steps: [number, number]; dims: [number, number]; dimMultiple: number };
  video: { fps: number; frames: number; frameStep: number; frameOffset: number; frameRange: [number, number]; resolutionPresets: Array<[number, number]> } | null;
  workflows: string[];
}

export interface DiffusionCatalog { families: DiffusionFamily[]; /** Family ids dropped for a field this parser refuses. */ skipped: string[] }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pair = (v: unknown): [number, number] | null =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0], v[1]] : null;

const FAMILY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const QUANT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const FILE_PART = /^[A-Za-z0-9_][A-Za-z0-9._+-]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** `owner/name` on Hugging Face, nothing that could climb or escape. */
export function isSafeRepo(repo: unknown): repo is string {
  if (typeof repo !== "string") return false;
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((p) => REPO_PART.test(p) && !p.includes(".."));
}

/** A path inside a repo: `/`-separated plain names, no `..`, no leading dot, not absolute. */
export function isSafeRepoFile(filename: unknown): filename is string {
  if (typeof filename !== "string" || filename.length > 512) return false;
  const parts = filename.split("/");
  return parts.every((p) => FILE_PART.test(p) && !p.includes(".."));
}

const basenameOf = (filename: string): string => filename.split("/").pop() ?? filename;

function file(v: unknown, field: boolean): DiffusionFile | null {
  const o = obj(v);
  const bytes = num(o?.bytes);
  const repo = o?.repo, filename = o?.filename;
  if (!o || !isSafeRepo(repo) || !isSafeRepoFile(filename) || bytes === null || !Number.isInteger(bytes) || bytes <= 0) return null;
  const sha = o.sha256 === undefined ? null : typeof o.sha256 === "string" && SHA256.test(o.sha256) ? o.sha256 : undefined;
  if (sha === undefined) return null;
  let f: EncoderField | null = null;
  if (field) {
    if (!(ENCODER_FIELDS as readonly unknown[]).includes(o.field)) return null;
    f = o.field as EncoderField;
  }
  return { repo, filename, bytes, sha256: sha, field: f };
}

function family(raw: unknown): DiffusionFamily | null {
  const f = obj(raw);
  const id = str(f?.id);
  if (!f || !id || !FAMILY_ID.test(id) || id === "shared" || id.includes("..")) return null;
  const modality = f.modality ?? "image";
  if (modality !== "image" && modality !== "video") return null;
  const t = obj(f.transformer);
  const repo = t?.repo;
  if (!t || !isSafeRepo(repo) || !Array.isArray(t.quants)) return null;
  const quants: DiffusionQuant[] = [];
  for (const q of t.quants) {
    const qo = obj(q);
    const parsed = file({ repo, filename: qo?.filename, bytes: qo?.bytes, sha256: qo?.sha256 }, false);
    const qid = str(qo?.id);
    if (!qo || !parsed || !qid || !QUANT_ID.test(qid)) return null;
    quants.push({ id: qid, label: str(qo.label) ?? qid.toUpperCase(), filename: parsed.filename, bytes: parsed.bytes, sha256: parsed.sha256, recommended: qo.recommended === true });
  }
  if (!quants.length || new Set(quants.map((q) => q.id)).size !== quants.length) return null;
  const vae = f.vae === undefined ? null : file(f.vae, false);
  const audioVae = f.audio_vae === undefined ? null : file(f.audio_vae, false);
  if ((f.vae !== undefined && !vae) || (f.audio_vae !== undefined && !audioVae)) return null;
  const textEncoders: DiffusionFile[] = [];
  for (const e of Array.isArray(f.text_encoders) ? f.text_encoders : []) {
    const parsed = file(e, true);
    if (!parsed) return null;
    textEncoders.push(parsed);
  }
  const d = obj(f.defaults);
  const r = obj(f.ranges);
  const steps = num(d?.steps), cfg = num(d?.cfg_scale), width = num(d?.width), height = num(d?.height);
  const rSteps = pair(r?.steps), dims = pair(r?.dims), multiple = num(r?.dim_multiple);
  if (!d || steps === null || cfg === null || width === null || height === null || !rSteps || !dims || multiple === null) return null;
  let video: DiffusionFamily["video"] = null;
  if (modality === "video") {
    const v = obj(f.video);
    const fps = num(v?.fps), frames = num(v?.frames), step = num(v?.frame_step), offset = num(v?.frame_offset), range = pair(v?.frame_range);
    if (!v || fps === null || frames === null || step === null || offset === null || !range) return null;
    const presets = (Array.isArray(v.resolution_presets) ? v.resolution_presets : []).map(pair).filter((p): p is [number, number] => p !== null);
    video = { fps, frames, frameStep: step, frameOffset: offset, frameRange: range, resolutionPresets: presets };
  }
  const caps = obj(f.capabilities) ?? {};
  const workflows = Array.isArray(caps.workflows) ? caps.workflows.filter((w): w is string => typeof w === "string") : [];
  const sigmas = Array.isArray(d.sigmas) && d.sigmas.every((s) => typeof s === "number") ? (d.sigmas as number[]) : undefined;
  return {
    id,
    name: str(f.name) ?? id,
    developer: str(f.developer),
    modality,
    description: str(f.description),
    license: str(f.license),
    gated: f.gated === true,
    repo,
    quants,
    vae,
    vaeFormat: str(f.vae_format),
    audioVae,
    textEncoders,
    defaults: {
      steps, cfgScale: cfg, width, height,
      ...(num(d.guidance) !== null ? { guidance: num(d.guidance)! } : {}),
      ...(str(d.sampling_method) ? { samplingMethod: str(d.sampling_method)! } : {}),
      ...(num(d.flow_shift) !== null ? { flowShift: num(d.flow_shift)! } : {}),
      ...(sigmas ? { sigmas: [...sigmas] } : {}),
    },
    ranges: { steps: rSteps, dims, dimMultiple: multiple },
    video,
    workflows: workflows.length ? workflows : ["create"],
  };
}

/** The conf file's families, each checked; null for a document of another schema. */
export function parseDiffusionCatalog(doc: unknown): DiffusionCatalog | null {
  const d = obj(doc);
  if (!d || d.schema_version !== 1 || !Array.isArray(d.families)) return null;
  const families: DiffusionFamily[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of d.families) {
    const f = family(raw);
    if (!f || seen.has(f.id)) {
      skipped.push(String(obj(raw)?.id ?? "?"));
      continue;
    }
    seen.add(f.id);
    families.push(f);
  }
  return { families, skipped };
}

/* -------------------------------------------------------- artifact ids */

/** One family + one quant: `z-image:q4_k_m`, the id Core's load and Studio's generate take. */
export function artifactId(familyId: string, quantId: string): string {
  return `${familyId}:${quantId}`;
}

export function parseArtifactId(id: unknown): { family: string; quant: string } | null {
  if (typeof id !== "string") return null;
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const family = id.slice(0, at), quant = id.slice(at + 1);
  return FAMILY_ID.test(family) && QUANT_ID.test(quant) ? { family, quant } : null;
}

export function findArtifact(catalog: DiffusionCatalog, id: unknown): { family: DiffusionFamily; quant: DiffusionQuant } | null {
  const parsed = parseArtifactId(id);
  const family = parsed && catalog.families.find((f) => f.id === parsed.family);
  const quant = family?.quants.find((q) => q.id === parsed!.quant);
  return family && quant ? { family, quant } : null;
}

/* ----------------------------------------------------------- paths */

export const SHARED_DIR = "shared";
/** Partial downloads: ours (`.part`) and the ones Core skips when it lists (install.ts PARTIAL_SUFFIXES). */
export const PARTIAL_SUFFIXES = [".tmp", ".part", ".download", ".url", ".parts", ".ranges", ".ranges.next"];

/** Our models root under the managed data dir. */
export function diffusionModelsDir(dataDir: string): string {
  return join(dataDir, "diffusion", "models");
}

/** `unsloth/Z-Image-Turbo-ComfyUI` → `unsloth--Z-Image-Turbo-ComfyUI`. */
export function sharedRepoDir(repo: string): string {
  return repo.replace(/\//g, "--");
}

export function hfResolveUrl(repo: string, filename: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${filename}`;
}

/**
 * The absolute path of `relativePath` under `root`, or null when the
 * relative path is not plain names or the result is not strictly inside
 * the root. Lexical; the downloader checks the real path once the folders
 * exist (a link planted inside the root).
 */
export function savePathUnder(root: string, relativePath: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!isAbsolute(root) || typeof relativePath !== "string" || relativePath.includes("\0") || relativePath.includes("\\") || isAbsolute(relativePath)) return null;
  const parts = relativePath.split("/");
  if (!parts.length || parts.some((p) => !FILE_PART.test(p) || p.includes(".."))) return null;
  const full = resolve(root, ...parts);
  const fold = (p: string) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const rel = relative(fold(resolve(root)), fold(full));
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? full : null;
}

/* ---------------------------------------------------- files on disk */

export interface ModelFile { path: string; relativePath: string; bytes: number }

/**
 * Regular files under `root`, recursively, `/`-separated relative paths;
 * hidden files, partial downloads and links skipped, as Core lists its
 * own store. An absent root is an empty list.
 */
export async function listModelFiles(root: string): Promise<ModelFile[]> {
  const out: ModelFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || PARTIAL_SUFFIXES.some((s) => entry.name.endsWith(s)) || entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const meta = await stat(path).catch(() => null);
      if (meta?.isFile()) out.push({ path, relativePath: relative(root, path).split(sep).join("/"), bytes: meta.size });
    }
  };
  await walk(root, 0);
  return out.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
}

/* ------------------------------------------------------------- plans */

export type EntryKind = "transformer" | "vae" | "audio_vae" | "text_encoder";

export interface PlanEntry {
  kind: EntryKind;
  repo: string;
  filename: string;
  url: string;
  bytes: number;
  sha256: string | null;
  field: EncoderField | null;
  relativePath: string;
  /** Absolute; empty when the plan was built without a root. */
  savePath: string;
  /** Needed for the workflow this plan was built for (the vision projector only for edit/reference). */
  required: boolean;
  /** A listed file with the same relative path and the same size. */
  present: boolean;
}

export interface ArtifactPlan { id: string; family: string; quant: string; entries: PlanEntry[]; totalBytes: number; missingBytes: number }

/** Qwen-Image-2.1 needs its VLM projector only for reference-conditioned work. */
export const workflowNeedsLlmVision = (workflow: string): boolean => workflow === "reference" || workflow === "edit";

/**
 * Everything one artifact needs on disk, with what is already there
 * marked. Throws for a quant the family does not list or a path that
 * would leave `root` (never for a catalog `parseDiffusionCatalog` took).
 */
export function planArtifact(family: DiffusionFamily, quantId: string, files: readonly ModelFile[], root: string, workflow = "create"): ArtifactPlan {
  const quant = family.quants.find((q) => q.id === quantId);
  if (!quant) throw new Error(`${family.id} has no quant "${quantId}"`);
  const entries: PlanEntry[] = [];
  const seen = new Set<string>();
  const push = (kind: EntryKind, f: { repo: string; filename: string; bytes: number; sha256: string | null; field: EncoderField | null }, relativePath: string) => {
    if (seen.has(relativePath)) return;
    seen.add(relativePath);
    const savePath = root ? savePathUnder(root, relativePath) : "";
    if (savePath === null) throw new Error(`unsafe model path: ${relativePath}`);
    entries.push({
      kind, repo: f.repo, filename: f.filename, url: hfResolveUrl(f.repo, f.filename), bytes: f.bytes, sha256: f.sha256, field: f.field,
      relativePath, savePath,
      required: f.field !== "llm_vision" || workflowNeedsLlmVision(workflow),
      present: files.some((x) => x.bytes === f.bytes && x.relativePath === relativePath),
    });
  };
  push("transformer", { repo: family.repo, filename: quant.filename, bytes: quant.bytes, sha256: quant.sha256, field: null }, `${family.id}/${basenameOf(quant.filename)}`);
  const shared = (f: DiffusionFile) => `${SHARED_DIR}/${sharedRepoDir(f.repo)}/${basenameOf(f.filename)}`;
  if (family.vae) push("vae", family.vae, shared(family.vae));
  if (family.audioVae) push("audio_vae", family.audioVae, shared(family.audioVae));
  for (const e of family.textEncoders) push("text_encoder", e, shared(e));
  const required = entries.filter((e) => e.required);
  return {
    id: artifactId(family.id, quant.id),
    family: family.id,
    quant: quant.id,
    entries,
    totalBytes: required.reduce((s, e) => s + e.bytes, 0),
    missingBytes: required.filter((e) => !e.present).reduce((s, e) => s + e.bytes, 0),
  };
}

export interface InstalledArtifact { id: string; family: string; quant: string; bytes: number; complete: boolean; missing: string[] }

/** Every artifact whose transformer is on disk; `complete` when the create plan has everything. */
export function installedArtifacts(catalog: DiffusionCatalog, files: readonly ModelFile[]): InstalledArtifact[] {
  const out: InstalledArtifact[] = [];
  for (const family of catalog.families) {
    for (const quant of family.quants) {
      const plan = planArtifact(family, quant.id, files, "");
      if (!plan.entries[0]!.present) continue;
      const missing = plan.entries.filter((e) => e.required && !e.present).map((e) => e.relativePath);
      out.push({ id: plan.id, family: family.id, quant: quant.id, bytes: plan.totalBytes, complete: missing.length === 0, missing });
    }
  }
  return out;
}

/** The files removing an artifact frees, and the shared ones another installed artifact still needs. */
export function planDeletion(catalog: DiffusionCatalog, family: DiffusionFamily, quantId: string, files: readonly ModelFile[]): { remove: ModelFile[]; kept: ModelFile[] } {
  const target = artifactId(family.id, quantId);
  const stillNeeded = new Set<string>();
  for (const other of installedArtifacts(catalog, files)) {
    if (other.id === target) continue;
    const of = catalog.families.find((f) => f.id === other.family);
    if (!of) continue;
    for (const e of planArtifact(of, other.quant, files, "", "edit").entries) if (e.kind !== "transformer") stillNeeded.add(e.relativePath);
  }
  const remove: ModelFile[] = [];
  const kept: ModelFile[] = [];
  // "edit" so an optional projector this artifact brought along goes with it.
  for (const e of planArtifact(family, quantId, files, "", "edit").entries) {
    const f = files.find((x) => x.relativePath === e.relativePath);
    if (!f) continue;
    (e.kind !== "transformer" && stillNeeded.has(e.relativePath) ? kept : remove).push(f);
  }
  return { remove, kept };
}

/* --------------------------------------------------------------- fit */

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** Metal refuses allocations past this share of unified memory (Atomic Chat hardware-tier.ts, measured). */
export const MACOS_LOAD_CEILING = 0.85;
/** Activation working set at one megapixel; scales with area (fit.ts). */
export const ACTIVATION_BYTES_PER_MEGAPIXEL = 1.5 * GIB;
export const FIT_OK_SHARE = 0.7;
export const FIT_MAYBE_SHARE = 0.9;

export interface MachineProfile {
  /** `unified`: Apple silicon / ARM, the GPU shares RAM. `system`: RAM only (a discrete GPU's memory is not read here). */
  memoryKind: "unified" | "system";
  ramBytes: number;
  /** What a model may use, after Metal's ceiling. */
  budgetBytes: number;
  /** Text encoders run on the CPU (always under Metal), so they do not count against the budget. */
  teOnCpu: boolean;
}

/** This machine as the fit sees it; null when the RAM is unknown. */
export function machineProfile(ramBytes: number, platform: NodeJS.Platform = process.platform, arch: string = process.arch): MachineProfile | null {
  if (!Number.isFinite(ramBytes) || ramBytes <= 0) return null;
  const mac = platform === "darwin";
  const unified = mac || arch === "arm64";
  return { memoryKind: unified ? "unified" : "system", ramBytes, budgetBytes: mac ? ramBytes * MACOS_LOAD_CEILING : ramBytes, teOnCpu: mac };
}

export type FitVerdict = "ok" | "maybe" | "no";

export interface FitEstimate {
  verdict: FitVerdict;
  policy: OffloadPolicy;
  residentBytes: number;
  budgetBytes: number | null;
  /** English, for a tooltip; the UI keys its own words on `verdict`. */
  reason: string;
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);

/** Transformer + VAE(s) + text encoders (unless on the CPU) + activations at the family's default size, against the budget. */
export function fitFor(family: DiffusionFamily, quant: DiffusionQuant, profile: MachineProfile | null): FitEstimate {
  const te = family.textEncoders.filter((e) => e.field !== "llm_vision").reduce((s, e) => s + e.bytes, 0);
  const activations = ACTIVATION_BYTES_PER_MEGAPIXEL * ((family.defaults.width * family.defaults.height) / (1024 * 1024));
  const residentBytes = quant.bytes + (family.vae?.bytes ?? 0) + (family.audioVae?.bytes ?? 0) + (profile?.teOnCpu ? 0 : te) + activations;
  if (!profile) {
    return { verdict: "maybe", policy: "group", residentBytes, budgetBytes: null, reason: `Needs about ${gb(residentBytes)} GB; this computer's memory is not known.` };
  }
  const share = residentBytes / profile.budgetBytes;
  if (share <= FIT_OK_SHARE) {
    return { verdict: "ok", policy: "none", residentBytes, budgetBytes: profile.budgetBytes, reason: `Needs about ${gb(residentBytes)} GB of ${gb(profile.budgetBytes)} GB available.` };
  }
  if (share <= FIT_MAYBE_SHARE) {
    return { verdict: "maybe", policy: "group", residentBytes, budgetBytes: profile.budgetBytes, reason: `Needs about ${gb(residentBytes)} GB of ${gb(profile.budgetBytes)} GB available; weights will be offloaded in groups.` };
  }
  return { verdict: "no", policy: "model", residentBytes, budgetBytes: profile.budgetBytes, reason: `Needs about ${gb(residentBytes)} GB but only ${gb(profile.budgetBytes)} GB is available; expect slow, CPU-offloaded generation.` };
}

/** The quant to recommend here: the curated one unless it does not fit, else the largest ok, else the largest maybe, else none. */
export function recommendedQuant(family: DiffusionFamily, profile: MachineProfile | null): DiffusionQuant | null {
  const verdict = (q: DiffusionQuant) => fitFor(family, q, profile).verdict;
  const largest = (qs: DiffusionQuant[]) => qs.reduce<DiffusionQuant | null>((best, q) => (!best || q.bytes > best.bytes ? q : best), null);
  const curated = family.quants.find((q) => q.recommended);
  if (curated && verdict(curated) !== "no") return curated;
  return largest(family.quants.filter((q) => verdict(q) === "ok")) ?? largest(family.quants.filter((q) => verdict(q) === "maybe"));
}

/** What the load asks Core for (fit.ts autoOffload without a VRAM reading: the estimate's policy). */
export function offloadFor(family: DiffusionFamily, fit: FitEstimate, platform: NodeJS.Platform = process.platform): OffloadPolicy {
  // Qwen-Image's Wan VAE page-faults Metal when kept on the GPU (Atomic Chat fit.ts).
  if (platform === "darwin" && family.id === "qwen-image") return "model";
  return fit.policy;
}

/* -------------------------------------------------------------- load */

/** Core's `LoadDiffusionModelRequest` (atomic-chat-core v0.18.6 src/contracts/diffusion.ts). */
export function buildLoadRequest(family: DiffusionFamily, quantId: string, files: readonly ModelFile[], root: string, opts: { offload: OffloadPolicy; workflow?: string }): Record<string, unknown> {
  const quant = family.quants.find((q) => q.id === quantId);
  if (!quant) throw new Error(`${family.id} has no quant "${quantId}"`);
  const plan = planArtifact(family, quantId, files, root, opts.workflow ?? "create");
  const pathOf = (e: PlanEntry) => files.find((f) => f.relativePath === e.relativePath)?.path ?? e.savePath;
  const out: Record<string, string> = {};
  for (const e of plan.entries) {
    if (!e.required) continue;
    if (e.kind === "transformer") out.diffusionModel = pathOf(e);
    else if (e.kind === "vae") { out.vae = pathOf(e); if (family.vaeFormat) out.vaeFormat = family.vaeFormat; }
    else if (e.kind === "audio_vae") out.audioVae = pathOf(e);
    else if (e.field) {
      const slot = { llm: "llm", llm_vision: "llmVision", qwen2vl: "qwen2vl", clip_l: "clipL", t5xxl: "t5xxl", embeddings_connectors: "embeddingsConnectors" }[e.field];
      out[slot] = pathOf(e);
    }
  }
  const v = family.video;
  return {
    modelId: plan.id,
    family: family.id,
    modality: family.modality,
    displayName: `${family.name} ${quant.label}`,
    files: out,
    defaults: {
      ...family.defaults,
      ...(family.defaults.sigmas ? { sigmas: [...family.defaults.sigmas] } : {}),
      ...(v ? { video: { fps: v.fps, frames: v.frames, frameStep: v.frameStep, frameOffset: v.frameOffset, resolutionPresets: v.resolutionPresets.map(([w, h]) => [w, h]) } } : {}),
    },
    ranges: {
      steps: [...family.ranges.steps],
      dims: [...family.ranges.dims],
      dimMultiple: family.ranges.dimMultiple,
      ...(v ? { frames: [...v.frameRange] } : {}),
    },
    offload: opts.offload,
    // Out of memory under the chosen policy: Core retries the load or the job once fully offloaded.
    ...(opts.offload !== "model" ? { offloadFallback: "model" } : {}),
  };
}

/* ------------------------------------------------------------- the UI */

export interface LocalDownloadState {
  id: string;
  state: "downloading" | "verifying" | "done" | "failed" | "cancelled";
  transferred: number;
  total: number;
  /** 0..100, whole. */
  percent: number;
  /** The file being fetched: 1-based index of `count`. */
  file: { index: number; count: number; name: string } | null;
  error: { code: string; message: string } | null;
}

export interface LocalQuantView {
  /** The artifact id generate and load take: `<family>:<quant>`. */
  id: string;
  quant: string;
  label: string;
  /** Everything the create workflow needs, shared files included. */
  bytes: number;
  /** What a download would still fetch. 0 when installed. */
  downloadBytes: number;
  installed: boolean;
  /** Some files are on disk (a stopped download, or a shared encoder), not all. */
  partial: boolean;
  /** The pick for this machine (`recommendedQuant`). */
  recommended: boolean;
  fit: FitEstimate;
  loaded: boolean;
  download: LocalDownloadState | null;
}

export interface LocalFamilyView {
  gated: boolean;
  installed: boolean;
  /** The quant a picker opens on: the largest installed that fits, else the recommended, else the smallest. */
  defaultQuant: string;
  quants: LocalQuantView[];
}

/** What the local section adds to one family's `StudioModel.local`. */
export function localFamilyView(family: DiffusionFamily, files: readonly ModelFile[], profile: MachineProfile | null, opts: { loadedId?: string | null; downloads?: ReadonlyMap<string, LocalDownloadState> } = {}): LocalFamilyView {
  const pick = recommendedQuant(family, profile);
  const quants = family.quants.map((q): LocalQuantView => {
    const plan = planArtifact(family, q.id, files, "");
    const anyPresent = plan.entries.some((e) => e.required && e.present);
    const installed = plan.missingBytes === 0;
    const dl = opts.downloads?.get(plan.id) ?? null;
    return {
      id: plan.id, quant: q.id, label: q.label,
      bytes: plan.totalBytes, downloadBytes: plan.missingBytes,
      installed, partial: !installed && anyPresent,
      recommended: pick?.id === q.id,
      fit: fitFor(family, q, profile),
      loaded: opts.loadedId === plan.id,
      download: dl && dl.state !== "done" ? dl : null,
    };
  });
  const installedFits = quants.filter((q) => q.installed && q.fit.verdict !== "no").sort((a, b) => b.bytes - a.bytes)[0];
  const smallest = [...family.quants].sort((a, b) => a.bytes - b.bytes)[0]!;
  return {
    gated: family.gated,
    installed: quants.some((q) => q.installed),
    defaultQuant: artifactId(family.id, installedFits?.quant ?? pick?.id ?? smallest.id),
    quants,
  };
}
