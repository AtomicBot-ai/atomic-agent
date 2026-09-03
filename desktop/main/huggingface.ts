/**
 * "Add a model from Hugging Face", main-process half.
 *
 * A VENDORED PORT. Every function below is copied, identifier for
 * identifier and string for string, from the agent's own modules:
 *
 *   src/local-llm/huggingface-ref.ts        → parseHuggingFaceModelRef & co.
 *   src/local-llm/huggingface-api.ts        → huggingFaceToken, listHuggingFaceGgufFiles,
 *                                             resolveHuggingFaceFileUrl
 *   src/local-llm/huggingface-fit.ts        → judgeGgufFile, describeRejectedGgufFiles,
 *                                             ramWarningFor and the four predicates
 *   src/local-llm/huggingface-model-def.ts  → buildCustomModelId, buildCustomModelDef
 *   src/local-llm/huggingface-resolve.ts    → resolveHuggingFaceGgufChoices
 *   src/local-llm/download-file.ts          → downloadProjector (a trim of downloadFile)
 *
 * It is a copy and not an import because desktop/tsconfig.json compiles
 * CommonJS with `rootDir: "."` and includes only main/** and preload/**,
 * while src/ is ESM with `.js` specifiers — the two trees cannot be
 * compiled together. It is a copy and not a call because the installed
 * agent exposes none of this: `atag models --help` has no `add`, there is
 * no HTTP route, and `resolveHuggingFaceGgufChoices` has callers only
 * inside src/tui.
 *
 * THE DRIFT IS REAL. When any of the six files above changes, this one
 * keeps the old behaviour and the old wording until someone re-syncs it.
 * The smoke asserts four of the user-visible strings verbatim so at least
 * those cannot drift silently.
 *
 * The renderer cannot do any of this itself: its CSP is
 * `connect-src 'none'` (desktop/renderer/index.html:7), so every listing
 * and every download crosses IPC into here.
 */

import * as fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/* ------------------------------------------------------------------ *
 * src/local-llm/huggingface-ref.ts
 * ------------------------------------------------------------------ */

const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

/** A repo, plus the one file inside it the reference named, if any. */
export interface HuggingFaceModelRef {
  /** `owner/name`. */
  repoId: string;
  /** Git revision — branch, tag or sha. `main` when the reference omits one. */
  revision: string;
  /** Path of a specific `.gguf` inside the repo, when one was named. */
  filePath: string | null;
}

const REPO_ID_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Strip a copied `hf download …` line down to its argument and drop any
 * trailing flags. The model card prints the whole command, so that is
 * what lands on the clipboard.
 */
function stripDownloadCommand(raw: string): string {
  return raw
    .replace(/^(?:hf|huggingface-cli|huggingface_hub)\s+download\s+/i, "")
    .split(/\s+--/)[0]!
    .trim();
}

/**
 * `hf://owner/repo[@revision]/path/to/file.gguf`, the scheme the `hf` CLI
 * accepts.
 *
 * Parsed by hand rather than with `new URL`: that puts the owner in the
 * host slot and lowercases it, and Hugging Face owners are
 * case-sensitive, so `hf://Qwen/…` would silently resolve to nothing.
 */
function parseHfSchemeRef(raw: string): HuggingFaceModelRef {
  const segments = raw.replace(/^hf:\/\//i, "").split("/").filter(Boolean);
  const head = segments[0]?.toLowerCase();
  if (head === "datasets" || head === "spaces") {
    throw new Error(
      `hf://${head}/… points at a ${head.replace(/s$/, "")}, not a model repo`,
    );
  }
  if (head === "models") segments.shift();
  const [owner, repoAndRevision, ...fileSegments] = segments;
  if (!owner || !repoAndRevision) {
    throw new Error(`hf:// reference is missing <owner>/<name>: ${JSON.stringify(raw)}`);
  }
  // Only the simple `repo@rev` form is supported, which is the one the
  // CLI prints; a revision containing a slash (`refs/pr/1`) would be
  // indistinguishable from the file path that follows it.
  const at = repoAndRevision.lastIndexOf("@");
  const name = at > 0 ? repoAndRevision.slice(0, at) : repoAndRevision;
  const revision = at > 0 ? repoAndRevision.slice(at + 1) : "main";
  return {
    repoId: `${owner}/${name}`,
    revision: revision || "main",
    filePath: fileSegments.length > 0 ? fileSegments.join("/") : null,
  };
}

/**
 * Accepts, in order of how often they get pasted:
 *   https://huggingface.co/<owner>/<name>
 *   https://huggingface.co/<owner>/<name>/tree/<rev>
 *   https://huggingface.co/<owner>/<name>/blob|resolve/<rev>/<file>.gguf
 *   hf.co/<owner>/<name>
 *   hf://<owner>/<name>[@rev][/<file>.gguf]
 *   hf download <owner>/<name> <file>.gguf
 *   <owner>/<name>
 *
 * Anything else throws with a message meant for the screen: the caller
 * shows it verbatim rather than turning it into "invalid input".
 */
export function parseHuggingFaceModelRef(raw: string): HuggingFaceModelRef {
  const command = stripDownloadCommand(raw.trim());
  const trimmed = command.replace(/[?#].*$/, "");
  if (trimmed.length === 0) throw new Error("Type a repo id or a huggingface.co URL.");

  if (/^hf:\/\//i.test(trimmed)) return parseHfSchemeRef(trimmed);

  // The two-argument `hf download` form. Narrow on purpose: the first
  // token has to look like a repo id, so an ordinary two-word phrase
  // still falls through to the URL branch and is rejected there.
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 2 && REPO_ID_RE.test(tokens[0]!) && /\.gguf$/i.test(tokens[1]!)) {
    return { repoId: tokens[0]!, revision: "main", filePath: tokens[1]! };
  }

  if (REPO_ID_RE.test(trimmed)) {
    return { repoId: trimmed, revision: "main", filePath: null };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(
      `Not a Hugging Face URL or an owner/name id: ${JSON.stringify(raw.trim())}`,
    );
  }
  if (!HF_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Not a huggingface.co URL: ${JSON.stringify(raw.trim())}`);
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "models") segments.shift();
  const [owner, name, verb, revision, ...rest] = segments;
  if (!owner || !name) {
    throw new Error(`That URL names no repo: ${JSON.stringify(raw.trim())}`);
  }
  const repoId = `${owner}/${name}`;
  if (verb === "resolve" || verb === "blob") {
    const filePath = rest.join("/");
    if (!filePath) {
      throw new Error(`That URL names no file: ${JSON.stringify(raw.trim())}`);
    }
    return { repoId, revision: revision || "main", filePath };
  }
  if (verb === "tree") return { repoId, revision: revision || "main", filePath: null };
  return { repoId, revision: "main", filePath: null };
}

/* ------------------------------------------------------------------ *
 * src/local-llm/huggingface-api.ts
 * ------------------------------------------------------------------ */

const HF_API = "https://huggingface.co/api";

export interface HuggingFaceFile {
  path: string;
  sizeBytes: number;
}

/**
 * Read only, never written and never shown. Note the asymmetry the
 * desktop cannot close: `atag models pull` also picks this up out of
 * `<stateDir>/.env` (load-config.ts applies the NAMES into process.env on
 * every CLI run), while this window sees only its own environment. That
 * is why a gated repo can fail to LIST here and still download fine.
 */
export function huggingFaceToken(): string | null {
  const raw = (process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "").trim();
  return raw.length > 0 ? raw : null;
}

async function fetchHfJson(
  path: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<unknown> {
  const token = huggingFaceToken();
  const timeout = AbortSignal.timeout(opts?.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`${HF_API}${path}`, {
      headers: {
        "User-Agent": "atomic-agent/local-llm",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: opts?.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
  } catch (err) {
    // The caller's own cancellation is not a network failure — let it
    // through untranslated so the screen that cancelled can tell the
    // difference from huggingface.co being down.
    if (opts?.signal?.aborted) throw err;
    throw new Error(
      `Could not reach huggingface.co: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Hugging Face returned ${res.status}: either no such repo, or it is gated. ` +
        (token
          ? "Your HF_TOKEN does not grant access — accept the licence on huggingface.co."
          : "If it is gated, accept its licence on huggingface.co and export HF_TOKEN."),
    );
  }
  if (res.status === 404) {
    throw new Error("Hugging Face returned 404: no repo or revision by that name.");
  }
  if (!res.ok) {
    throw new Error(`Hugging Face returned HTTP ${res.status} ${res.statusText}.`);
  }
  return res.json();
}

/** Every `.gguf` in a repo revision, with its real (LFS) size. */
export async function listHuggingFaceGgufFiles(
  repoId: string,
  revision = "main",
  opts?: { signal?: AbortSignal },
): Promise<HuggingFaceFile[]> {
  const raw = await fetchHfJson(
    `/models/${repoId}/tree/${encodeURIComponent(revision)}?recursive=true`,
    opts,
  );
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : null;
    if (!path || !path.toLowerCase().endsWith(".gguf")) return [];
    // Everything over 10 MB is stored in LFS, where `size` on the tree
    // entry is the pointer file's size, not the model's.
    const lfs = record.lfs as Record<string, unknown> | undefined;
    const sizeBytes =
      typeof lfs?.size === "number"
        ? lfs.size
        : typeof record.size === "number"
          ? record.size
          : 0;
    return [{ path, sizeBytes }];
  });
}

export function resolveHuggingFaceFileUrl(
  repoId: string,
  revision: string,
  filePath: string,
): string {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repoId}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}

/* ------------------------------------------------------------------ *
 * src/local-llm/huggingface-fit.ts
 * ------------------------------------------------------------------ */

export type GgufVerdict =
  | "usable"
  /** An `mmproj-*.gguf` vision projector — an accessory, not weights. */
  | "projector"
  /** One part of a `-00001-of-000NN` set; the downloader fetches one file. */
  | "sharded"
  /** A speculative-decoding (MTP/NextN) companion, not a servable model. */
  | "companion"
  /** F16/F32/BF16 weights: a conversion step, not a quantisation. */
  | "unquantised";

export interface GgufJudgement {
  verdict: GgufVerdict;
  /** Shown verbatim when this file is the one the operator asked for. */
  reason: string | null;
}

export function isMmprojFile(path: string): boolean {
  return /(^|\/)mmproj[^/]*\.gguf$/i.test(path);
}

/**
 * Multi-part GGUFs are named `…-00001-of-00003.gguf`. The installer
 * fetches exactly one file, so any shard — the first included — yields a
 * model that cannot load. Serving them means fetching the whole set.
 */
export function isShardedGguf(path: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(path);
}

/**
 * MTP/NextN companions are GGUFs but not runnable models, and they are
 * small, so a size-based fallback would happily pick one when a repo
 * ships nothing else recognisable.
 */
export function isMtpCompanionFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /(^|\/)mtp\//i.test(path) || /(^|[-_.])mtp([-_.]|\.gguf$)/i.test(name);
}

/**
 * Full-precision weights. Repos that ship quants almost always ship the
 * F16 they were quantised from next to them, and it is several times the
 * size of anything the operator wants on a first run.
 */
export function isFullPrecisionGguf(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /(^|[-_.])(?:f16|f32|bf16|fp16|fp32)(?=[-_.]|\.gguf$)/i.test(name);
}

export function judgeGgufFile(path: string): GgufJudgement {
  if (!/\.gguf$/i.test(path)) {
    return { verdict: "unquantised", reason: `${path} is not a .gguf file` };
  }
  if (isMmprojFile(path)) {
    return {
      verdict: "projector",
      reason:
        "that is a vision projector, not model weights — name the repo instead " +
        "and the projector is picked up with it",
    };
  }
  if (isShardedGguf(path)) {
    return {
      verdict: "sharded",
      reason:
        "that is one part of a multi-part model; only the part would be " +
        "downloaded and it would not load. Pick a single-file quant.",
    };
  }
  if (isMtpCompanionFile(path)) {
    return {
      verdict: "companion",
      reason:
        "that looks like a speculative-decoding companion (MTP/NextN), not " +
        "runnable weights — pick the main GGUF.",
    };
  }
  if (isFullPrecisionGguf(path)) {
    return {
      verdict: "unquantised",
      reason:
        "that is the full-precision conversion, not a quantisation — pick a " +
        "Q4/Q5/Q8 file from the same repo.",
    };
  }
  return { verdict: "usable", reason: null };
}

/** Plural-aware tally of what was filtered out, or `null` when nothing was. */
export function describeRejectedGgufFiles(
  verdicts: readonly GgufVerdict[],
): string | null {
  const labels: Record<Exclude<GgufVerdict, "usable">, string> = {
    projector: "vision projector",
    sharded: "multi-part",
    companion: "speculative-decoding companion",
    unquantised: "full-precision",
  };
  const counts = new Map<string, number>();
  for (const verdict of verdicts) {
    if (verdict === "usable") continue;
    const label = labels[verdict];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const parts = [...counts].map(([label, n]) => `${n} ${label}`);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return `${total} more file${total === 1 ? "" : "s"} hidden: ${parts.join(", ")}`;
}

/**
 * Weights bigger than physical RAM still start — llama.cpp memory-maps
 * the file and the OS pages it in — they are just slow enough that
 * saying so is worth a line. This warns; nothing acts on it.
 */
export function ramWarningFor(fileSizeGb: number, hostRamGb: number): string | null {
  if (fileSizeGb <= 0 || hostRamGb <= 0) return null;
  if (fileSizeGb <= hostRamGb) return null;
  return (
    `${fileSizeGb.toFixed(1)} GB model, ${hostRamGb} GB of RAM — ` +
    `it will run from disk, slowly.`
  );
}

/* ------------------------------------------------------------------ *
 * src/local-llm/huggingface-model-def.ts
 * ------------------------------------------------------------------ */

const BYTES_PER_GB = 1024 * 1024 * 1024;

/** The shape `localModels.customModels` validates against (custom-models-schema.ts). */
export interface LocalModelDef {
  id: string;
  name: string;
  filename: string;
  huggingFaceUrl: string;
  fileSizeGb: number;
  sizeLabel: string;
  description: string;
  maxContextLength: number;
  contextLabel: string;
  minRamGb: number;
  recommendedRamGb: number;
  family: string;
  supportsVision: boolean;
  mmprojUrl?: string;
  mmprojFilename?: string;
  mmprojFileSizeGb?: number;
}

/**
 * A filesystem-safe id for a user-added model. `<dataDir>/models/<id>/`
 * is created verbatim from this, so the character filter has to survive
 * Windows path rules as well as POSIX ones.
 */
export function buildCustomModelId(repoId: string, filePath: string): string {
  const base = filePath.split("/").pop()!.replace(/\.gguf$/i, "");
  const slug = `${repoId}-${base}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `custom-${slug.slice(0, 80)}`;
}

export function formatGgufSize(bytes: number): string {
  if (bytes <= 0) return "unknown";
  const gb = bytes / BYTES_PER_GB;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function ggufSizeGb(bytes: number): number {
  return bytes / BYTES_PER_GB;
}

/**
 * The curated catalog hand-writes a context window and a RAM envelope
 * per model. Neither is exposed by the Hugging Face API without reading
 * the GGUF header, so both are estimated: RAM as weights × 1.2 (minimum)
 * and × 1.5 + 2 GB (recommended), and `maxContextLength: 0` hands the
 * context decision to `resolveEffectiveContextSize`, which fits it to the
 * device. Both numbers are advisory everywhere they are read.
 */
export function buildCustomModelDef(input: {
  repoId: string;
  revision: string;
  file: HuggingFaceFile;
  mmproj: HuggingFaceFile | null;
}): LocalModelDef {
  const { repoId, revision, file, mmproj } = input;
  const fileSizeGb = ggufSizeGb(file.sizeBytes);
  const filename = file.path.split("/").pop()!;
  const base: LocalModelDef = {
    id: buildCustomModelId(repoId, file.path),
    name: `${repoId} · ${filename}`,
    filename,
    huggingFaceUrl: resolveHuggingFaceFileUrl(repoId, revision, file.path),
    fileSizeGb,
    sizeLabel: formatGgufSize(file.sizeBytes),
    description: `Added from huggingface.co/${repoId}`,
    maxContextLength: 0,
    contextLabel: "auto",
    minRamGb: Math.max(1, Math.ceil(fileSizeGb * 1.2)),
    recommendedRamGb: Math.max(2, Math.ceil(fileSizeGb * 1.5) + 2),
    family: "custom",
    supportsVision: mmproj !== null,
  };
  if (!mmproj) return base;
  return {
    ...base,
    mmprojUrl: resolveHuggingFaceFileUrl(repoId, revision, mmproj.path),
    mmprojFilename: mmproj.path.split("/").pop()!,
    mmprojFileSizeGb: ggufSizeGb(mmproj.sizeBytes),
  };
}

/* ------------------------------------------------------------------ *
 * src/local-llm/huggingface-resolve.ts
 * ------------------------------------------------------------------ */

/** One servable GGUF, in the shape the picker draws. */
export interface HuggingFaceGgufChoice {
  path: string;
  filename: string;
  sizeBytes: number;
  fileSizeGb: number;
  sizeLabel: string;
}

export interface HuggingFaceRepoChoices {
  repoId: string;
  revision: string;
  /**
   * Best-known quantisation first (see `QUANT_PREFERENCE`), then by
   * size within a rank — the file most likely to run well here leads
   * the list, and that is rarely the smallest one.
   */
  choices: readonly HuggingFaceGgufChoice[];
  /** The projector to pull alongside, when the repo ships one. */
  mmproj: HuggingFaceFile | null;
  /** One line naming what was filtered out, or `null` when nothing was. */
  hidden: string | null;
}

/** Best-known quants first; anything unrecognised sorts by size after them. */
const QUANT_PREFERENCE = ["q4_k_xl", "q4_k_m", "q4_k_s", "q4_0", "q5_k_m", "q8_0"];

function quantRank(path: string): number {
  const lower = path.toLowerCase();
  const index = QUANT_PREFERENCE.findIndex((quant) => lower.includes(quant));
  return index === -1 ? QUANT_PREFERENCE.length : index;
}

function toChoice(file: HuggingFaceFile): HuggingFaceGgufChoice {
  return {
    path: file.path,
    filename: file.path.split("/").pop() ?? file.path,
    sizeBytes: file.sizeBytes,
    fileSizeGb: ggufSizeGb(file.sizeBytes),
    sizeLabel: formatGgufSize(file.sizeBytes),
  };
}

function pickMmproj(files: readonly HuggingFaceFile[]): HuggingFaceFile | null {
  const projectors = files.filter((file) => isMmprojFile(file.path));
  if (projectors.length === 0) return null;
  return [...projectors].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;
}

/**
 * Resolve a pasted reference into the files worth offering.
 *
 * A reference that names one file collapses to a single choice — or to a
 * refusal quoting why that file cannot be served, which is more useful
 * than silently substituting a different one.
 */
export async function resolveHuggingFaceGgufChoices(
  reference: string,
  opts?: { signal?: AbortSignal },
): Promise<HuggingFaceRepoChoices> {
  const ref = parseHuggingFaceModelRef(reference);
  const files = await listHuggingFaceGgufFiles(ref.repoId, ref.revision, opts);
  if (files.length === 0) {
    throw new Error(
      `No .gguf files in ${ref.repoId} — that is the original model, not a ` +
        `GGUF conversion of it. Look for a "-GGUF" repo of the same name.`,
    );
  }
  const mmproj = pickMmproj(files);

  if (ref.filePath) {
    const named = files.find((file) => file.path === ref.filePath);
    if (!named) {
      throw new Error(`${ref.filePath} is not in ${ref.repoId} @ ${ref.revision}.`);
    }
    const judgement = judgeGgufFile(named.path);
    if (judgement.verdict !== "usable") {
      throw new Error(`Cannot use ${named.path}: ${judgement.reason}`);
    }
    return {
      repoId: ref.repoId,
      revision: ref.revision,
      choices: [toChoice(named)],
      mmproj,
      hidden: null,
    };
  }

  const usable: HuggingFaceFile[] = [];
  const rejected: GgufVerdict[] = [];
  for (const file of files) {
    const { verdict } = judgeGgufFile(file.path);
    if (verdict === "usable") usable.push(file);
    else rejected.push(verdict);
  }
  if (usable.length === 0) {
    throw new Error(
      `${ref.repoId} has ${files.length} GGUF file${files.length === 1 ? "" : "s"} but ` +
        `none this agent can serve (${describeRejectedGgufFiles(rejected) ?? "unknown"}).`,
    );
  }
  const choices = usable
    .sort((a, b) => quantRank(a.path) - quantRank(b.path) || a.sizeBytes - b.sizeBytes)
    .map(toChoice);
  return {
    repoId: ref.repoId,
    revision: ref.revision,
    choices,
    mmproj,
    hidden: describeRejectedGgufFiles(rejected),
  };
}

/* ------------------------------------------------------------------ *
 * src/local-llm/download-file.ts, trimmed to the projector case
 * ------------------------------------------------------------------ */

/**
 * `atag models pull` fetches the WEIGHTS and stops — verified twice:
 * `runLocalModelsPull` (src/cli/models-handlers.ts) calls `downloadModel`
 * and nothing else, and after a real CLI pull of a vision repo the model
 * directory held only the weights file. The TUI's own add is two phases
 * (`pullGgufPhase` then `pullMmprojPhase`); the CLI has only the first.
 *
 * So the desktop fetches the projector itself, or a model this window
 * just labelled vision-capable would run text-only forever with nothing
 * anywhere saying why. The GitHub branch of the original is dropped: a
 * projector URL is always huggingface.co.
 */
export async function downloadProjector(
  url: string,
  destPath: string,
  opts?: {
    onProgress?: (percent: number, transferred: number, total: number) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (opts?.signal?.aborted) throw abortError();
  const token = huggingFaceToken();
  const headers: Record<string, string> = {
    "User-Agent": "atomic-agent/local-llm",
    // Gated repos answer 401 without this; public ones ignore it, so it
    // costs nothing to send whenever the operator has a token exported.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { headers, redirect: "follow", signal: opts?.signal });
  if (opts?.signal?.aborted) throw abortError();
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const totalRaw = res.headers.get("content-length");
  const total = totalRaw ? parseInt(totalRaw, 10) : 0;
  let transferred = 0;
  let lastEmitAt = 0;
  let lastEmittedBytes = -1;
  /** A time base, not a percentage base: one percent of a GGUF is tens of MB. */
  const PROGRESS_INTERVAL_MS = 200;
  const emitProgress = (now: number): void => {
    if (transferred === lastEmittedBytes) return;
    lastEmitAt = now;
    lastEmittedBytes = transferred;
    const percent = total > 0 ? Math.round((transferred / total) * 100) : 0;
    opts?.onProgress?.(percent, transferred, total);
  };
  const reader = res.body.getReader();
  const tracking = new ReadableStream({
    async pull(controller) {
      if (opts?.signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (opts?.signal?.aborted) throw abortError();
      if (done) {
        emitProgress(Date.now());
        controller.close();
        return;
      }
      transferred += value.byteLength;
      const now = Date.now();
      if (now - lastEmitAt >= PROGRESS_INTERVAL_MS) emitProgress(now);
      controller.enqueue(value);
    },
  });
  const nodeReadable = Readable.fromWeb(
    tracking as unknown as import("node:stream/web").ReadableStream,
  );
  const tmpPath = `${destPath}.tmp`;
  try {
    await pipeline(nodeReadable, fs.createWriteStream(tmpPath));
    if (opts?.signal?.aborted) throw abortError();
    fs.renameSync(tmpPath, destPath);
  } finally {
    // A cancelled download restarts from the beginning; leaving the part
    // file behind would only look like progress that is not there.
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function abortError(): Error {
  const err = new Error("Download aborted");
  err.name = "AbortError";
  return err;
}

/**
 * The schema's own filename rule (src/config/custom-models-schema.ts
 * `requireSafeFilename`): the name is joined under
 * `<dataDir>/models/<id>/`, so a separator or a leading dot in a
 * repo-controlled string would climb out of the model directory.
 */
export function isSafeModelFilename(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.startsWith(".")
  );
}
