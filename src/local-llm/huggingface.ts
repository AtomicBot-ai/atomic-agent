/**
 * Hugging Face model discovery: turn a pasted URL / repo id — or a
 * search query — into a `LocalModelDef` the rest of the local-LLM
 * stack already knows how to download, activate and serve.
 *
 * Everything here is derived from two public JSON endpoints:
 *   - `GET /api/models?search=…&filter=gguf`   — repo search
 *   - `GET /api/models/<repo>/tree/<rev>`      — file listing + sizes
 *
 * Gated / private repos work when `HF_TOKEN` (or
 * `HUGGING_FACE_HUB_TOKEN`) is exported — the same token is attached by
 * `downloadFile` for the actual GGUF fetch.
 */

import type { LocalModelDef, LocalModelId } from "./models-catalog.js";

const HF_API = "https://huggingface.co/api";
const HF_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);

/** A repo (+ optional file) the user pointed at. */
export interface HuggingFaceModelRef {
  /** `owner/name`. */
  repoId: string;
  /** Git revision — branch, tag or sha. Defaults to `main`. */
  revision: string;
  /** Path of a specific `.gguf` inside the repo, when the user named one. */
  filePath: string | null;
}

export interface HuggingFaceFile {
  path: string;
  sizeBytes: number;
}

export interface HuggingFaceSearchHit {
  repoId: string;
  downloads: number;
  likes: number;
}

export function huggingFaceToken(): string | null {
  const raw = (
    process.env.HF_TOKEN ||
    process.env.HUGGING_FACE_HUB_TOKEN ||
    ""
  ).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Strip a copied `hf`/`huggingface-cli` command down to its argument, and
 * drop any trailing flags (`--local-dir …`). People paste the whole line
 * off a model card, not just the reference inside it.
 */
function stripDownloadCommand(raw: string): string {
  return raw
    .replace(/^(?:hf|huggingface-cli|huggingface_hub)\s+download\s+/i, "")
    .split(/\s+--/)[0]!
    .trim();
}

/**
 * `hf://owner/repo[@revision]/path/to/file.gguf` — the `HfFileSystem`
 * scheme the `hf` CLI accepts.
 *
 * Parsed by hand rather than with `new URL`: that would put `owner` in
 * the host slot and lowercase it, and Hugging Face owners are
 * case-sensitive (`Qwen/…` is not `qwen/…`).
 */
function parseHfSchemeRef(raw: string): HuggingFaceModelRef {
  const segments = raw.replace(/^hf:\/\//i, "").split("/").filter(Boolean);
  const head = segments[0]?.toLowerCase();
  if (head === "datasets" || head === "spaces") {
    throw new Error(
      `hf://${head}/… is a ${head.replace(/s$/, "")}, not a model repo`,
    );
  }
  if (head === "models") segments.shift();
  const [owner, repoAndRevision, ...fileSegments] = segments;
  if (!owner || !repoAndRevision) {
    throw new Error(
      `hf:// reference is missing <owner>/<name>: ${JSON.stringify(raw)}`,
    );
  }
  // `repo@refs/pr/1` — the revision runs to the first path separator, so
  // anything after the `@` on this segment plus following segments up to
  // the filename would be ambiguous; only the simple `repo@rev` form is
  // supported, which is what the CLI prints.
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
 * Parse anything a user is likely to paste:
 *   https://huggingface.co/<repo>/resolve/<rev>/<file>.gguf
 *   https://huggingface.co/<repo>/blob/<rev>/<file>.gguf
 *   https://huggingface.co/<repo>/tree/<rev>
 *   https://huggingface.co/<repo>
 *   hf.co/<repo>
 *   hf://<repo>[@rev]/<file>.gguf
 *   hf download hf://<repo>/<file>.gguf     (command pasted whole)
 *   hf download <repo> <file>.gguf
 *   <owner>/<name>
 *
 * Throws `Error` with a user-facing message on anything else — callers
 * use that to distinguish "this is a reference" from "this is a search
 * query", so it must keep rejecting free text.
 */
export function parseHuggingFaceModelRef(raw: string): HuggingFaceModelRef {
  const command = stripDownloadCommand(raw.trim());
  const trimmed = command.replace(/[?#].*$/, "");
  if (trimmed.length === 0) throw new Error("empty model reference");

  if (/^hf:\/\//i.test(trimmed)) return parseHfSchemeRef(trimmed);

  // `<repo> <file.gguf>` — the two-argument `hf download` form. Narrow on
  // purpose: the first token must look like a repo id, so an ordinary
  // two-word search ("qwen3 coder") still falls through and throws.
  const tokens = trimmed.split(/\s+/);
  if (
    tokens.length === 2 &&
    /^[\w.-]+\/[\w.-]+$/.test(tokens[0]!) &&
    /\.gguf$/i.test(tokens[1]!)
  ) {
    return { repoId: tokens[0]!, revision: "main", filePath: tokens[1]! };
  }

  const bare = /^[\w.-]+\/[\w.-]+$/.exec(trimmed);
  if (bare) {
    return { repoId: trimmed, revision: "main", filePath: null };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(
      `not a Hugging Face model URL or <owner>/<name> id: ${JSON.stringify(raw)}`,
    );
  }
  if (!HF_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`not a huggingface.co URL: ${JSON.stringify(raw)}`);
  }
  // Optional `/models/` prefix used by some share links.
  const segs = url.pathname.split("/").filter(Boolean);
  if (segs[0] === "models") segs.shift();
  const [owner, name, verb, revision, ...rest] = segs;
  if (!owner || !name) {
    throw new Error(`URL is missing <owner>/<name>: ${JSON.stringify(raw)}`);
  }
  const repoId = `${owner}/${name}`;
  if (verb === "resolve" || verb === "blob") {
    const filePath = rest.join("/");
    if (!filePath) {
      throw new Error(`URL is missing a file path: ${JSON.stringify(raw)}`);
    }
    return { repoId, revision: revision || "main", filePath };
  }
  if (verb === "tree") {
    return { repoId, revision: revision || "main", filePath: null };
  }
  return { repoId, revision: "main", filePath: null };
}

/**
 * True when text is *unambiguously* a Hugging Face reference — it names
 * the host, the `hf://` scheme, or a pasted `hf download` command.
 *
 * Deliberately stricter than `parseHuggingFaceModelRef`, which also
 * accepts a bare `owner/name`: `192.168.1.5/api` satisfies that shape
 * and is far more likely to be a llama-server address. Callers that must
 * choose between "add this model" and "set this base URL" use this, so
 * the two never drift apart the way a second inline regex would.
 */
export function looksLikeHuggingFaceReference(text: string): boolean {
  const trimmed = text.trim();
  return (
    /^hf:\/\//i.test(trimmed) ||
    /^(?:hf|huggingface-cli|huggingface_hub)\s+download\s+/i.test(trimmed) ||
    /(?:^|\/\/|\.)(?:huggingface\.co|hf\.co)(?:$|[/:])/i.test(trimmed)
  );
}

async function fetchHfJson(path: string, timeoutMs = 15_000): Promise<unknown> {
  const token = huggingFaceToken();
  const res = await fetch(`${HF_API}${path}`, {
    headers: {
      "User-Agent": "atomic-agent/local-llm",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) {
    // HF returns 401 for private *and* nonexistent repos — it does not
    // leak which — so the message has to cover both.
    throw new Error(
      `Hugging Face returned ${res.status} — no such repo, or it is gated/private. ` +
        `Check the id; if it is gated, accept its licence on huggingface.co and export HF_TOKEN.`,
    );
  }
  if (res.status === 404) {
    throw new Error("Hugging Face returned 404 — no such model repo/revision.");
  }
  if (!res.ok) {
    throw new Error(`Hugging Face API error: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Search GGUF-tagged model repos, most-downloaded first. */
export async function searchHuggingFaceGgufModels(
  query: string,
  limit = 20,
): Promise<HuggingFaceSearchHit[]> {
  const q = query.trim();
  if (q.length === 0) throw new Error("empty search query");
  const params = new URLSearchParams({
    search: q,
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    limit: String(limit),
  });
  const raw = await fetchHfJson(`/models?${params.toString()}`);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const o = entry as Record<string, unknown>;
    const repoId = typeof o.id === "string" ? o.id : null;
    if (!repoId) return [];
    return [
      {
        repoId,
        downloads: typeof o.downloads === "number" ? o.downloads : 0,
        likes: typeof o.likes === "number" ? o.likes : 0,
      },
    ];
  });
}

/** List the `.gguf` files in a repo revision, with real (LFS) sizes. */
export async function listHuggingFaceGgufFiles(
  repoId: string,
  revision = "main",
): Promise<HuggingFaceFile[]> {
  const raw = await fetchHfJson(
    `/models/${repoId}/tree/${encodeURIComponent(revision)}?recursive=true`,
  );
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const o = entry as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path : null;
    if (!path || !path.toLowerCase().endsWith(".gguf")) return [];
    const lfs = o.lfs as Record<string, unknown> | undefined;
    const size =
      typeof lfs?.size === "number"
        ? lfs.size
        : typeof o.size === "number"
          ? o.size
          : 0;
    return [{ path, sizeBytes: size }];
  });
}

export function isMmprojFile(path: string): boolean {
  return /(^|\/)mmproj[^/]*\.gguf$/i.test(path);
}

/**
 * Multi-part GGUFs are named `…-00001-of-00003.gguf`. The downloader
 * fetches exactly one file, so ANY shard — first included — yields a
 * model llama-server cannot start (the remaining parts are missing).
 * Sharded picks are therefore rejected outright with a clear error
 * instead of producing a silently broken install. Support means
 * fetching the full set; do that if sharded repos become common.
 */
export function isShardedGguf(path: string): boolean {
  return /-\d{5}-of-\d{5}\.gguf$/i.test(path);
}

/**
 * Speculative-decoding companion files (MTP/NextN) are GGUFs but not
 * runnable models. They are usually tiny, so the smallest-file fallback
 * in `pickDefaultGgufFile` would otherwise happily select one when none
 * of the preferred quants exist. Patterns: an `mtp/` folder, or `mtp`
 * as a delimited token in the file name.
 */
export function isMtpCompanionFile(path: string): boolean {
  return /(^|\/)mtp\//i.test(path) || /(^|[-_.])mtp([-_.]|\.gguf$)/i.test(
    path.split("/").pop() ?? path,
  );
}

const QUANT_PREFERENCE = [
  "q4_k_xl",
  "q4_k_m",
  "q4_k_s",
  "q4_0",
  "q5_k_m",
  "q8_0",
];

/**
 * Pick the weights file when the user named a repo but not a file:
 * the best-known 4-bit quant, else the smallest remaining candidate
 * (small is the safer default — it loads on more machines).
 */
export function pickDefaultGgufFile(
  files: readonly HuggingFaceFile[],
): HuggingFaceFile | null {
  const candidates = files.filter(
    (f) =>
      !isMmprojFile(f.path) &&
      !isShardedGguf(f.path) &&
      !isMtpCompanionFile(f.path),
  );
  if (candidates.length === 0) return null;
  for (const quant of QUANT_PREFERENCE) {
    const hit = candidates.find((f) => f.path.toLowerCase().includes(quant));
    if (hit) return hit;
  }
  return [...candidates].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;
}

/** Smallest mmproj projector in the repo, when one exists. */
export function pickMmprojFile(
  files: readonly HuggingFaceFile[],
): HuggingFaceFile | null {
  const projectors = files.filter((f) => isMmprojFile(f.path));
  if (projectors.length === 0) return null;
  return [...projectors].sort((a, b) => a.sizeBytes - b.sizeBytes)[0]!;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;

export function resolveHuggingFaceFileUrl(
  repoId: string,
  revision: string,
  filePath: string,
): string {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repoId}/resolve/${encodeURIComponent(revision)}/${encoded}`;
}

/**
 * Stable, filesystem-safe id for a user-added model. `<dataDir>/models/<id>/`
 * is created verbatim from this, so it must survive Windows path rules —
 * hence the aggressive character filter.
 */
export function buildCustomModelId(
  repoId: string,
  filePath: string,
): LocalModelId {
  const base = filePath.split("/").pop()!.replace(/\.gguf$/i, "");
  const slug = `${repoId}-${base}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `custom-${slug.slice(0, 80)}`;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return "unknown";
  const gb = bytes / BYTES_PER_GB;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Assemble the catalog entry. Metadata the curated catalog hand-writes
 * (context window, RAM envelope) is not exposed by the HF API without
 * parsing GGUF headers, so it is estimated:
 *
 * ponytail: RAM bounds are weights × 1.2 / × 1.5 + 2 GB, and
 * `maxContextLength: 0` hands the context decision to
 * `resolveEffectiveContextSize` (fit-to-VRAM auto). Both are advisory —
 * read the real values from the GGUF header if the estimates mislead.
 */
export function buildCustomModelDef(input: {
  repoId: string;
  revision: string;
  file: HuggingFaceFile;
  mmproj: HuggingFaceFile | null;
}): LocalModelDef {
  const { repoId, revision, file, mmproj } = input;
  const fileSizeGb = file.sizeBytes / BYTES_PER_GB;
  const filename = file.path.split("/").pop()!;
  return {
    id: buildCustomModelId(repoId, file.path),
    name: `${repoId} · ${filename}`,
    filename,
    huggingFaceUrl: resolveHuggingFaceFileUrl(repoId, revision, file.path),
    fileSizeGb,
    sizeLabel: formatSize(file.sizeBytes),
    description: `Custom model from huggingface.co/${repoId}`,
    maxContextLength: 0,
    contextLabel: "auto",
    minRamGb: Math.max(1, Math.ceil(fileSizeGb * 1.2)),
    recommendedRamGb: Math.max(2, Math.ceil(fileSizeGb * 1.5) + 2),
    family: "custom",
    supportsVision: mmproj !== null,
    ...(mmproj
      ? {
          mmprojUrl: resolveHuggingFaceFileUrl(repoId, revision, mmproj.path),
          mmprojFilename: mmproj.path.split("/").pop()!,
          mmprojFileSizeGb: mmproj.sizeBytes / BYTES_PER_GB,
        }
      : {}),
  };
}

/**
 * End-to-end: pasted URL / repo id → catalog entry ready to download.
 * Resolves the weights file (explicit, or best-guess quant) and any
 * mmproj projector sitting next to it in the same repo.
 */
export async function resolveCustomModelFromHuggingFace(
  reference: string,
): Promise<LocalModelDef> {
  const ref = parseHuggingFaceModelRef(reference);
  const files = await listHuggingFaceGgufFiles(ref.repoId, ref.revision);
  if (files.length === 0) {
    throw new Error(
      `no .gguf files in huggingface.co/${ref.repoId} @ ${ref.revision} — ` +
        `pick a GGUF conversion of the model (usually a "-GGUF" repo).`,
    );
  }
  let file: HuggingFaceFile | null;
  if (ref.filePath) {
    file = files.find((f) => f.path === ref.filePath) ?? null;
    if (!file) {
      throw new Error(
        `${ref.filePath} not found in ${ref.repoId} @ ${ref.revision}`,
      );
    }
    if (isMmprojFile(file.path)) {
      throw new Error(
        `${ref.filePath} is an mmproj projector, not model weights — ` +
          `paste the repo URL instead and the projector is picked up automatically.`,
      );
    }
    if (isShardedGguf(file.path)) {
      throw new Error(
        `${ref.filePath} is one part of a sharded model — only this part ` +
          `would be downloaded and the model would not start. Sharded ` +
          `models are not supported yet; pick a single-file quant instead.`,
      );
    }
    if (isMtpCompanionFile(file.path)) {
      throw new Error(
        `${ref.filePath} looks like a speculative-decoding companion ` +
          `(MTP/NextN), not runnable model weights — pick the main GGUF.`,
      );
    }
  } else {
    file = pickDefaultGgufFile(files);
    if (!file) {
      const sharded = files.some((f) => isShardedGguf(f.path));
      throw new Error(
        sharded
          ? `${ref.repoId} only ships sharded (multi-part) weights, which ` +
            `are not supported yet — look for a single-file quant of the model`
          : `no usable .gguf weights in ${ref.repoId}`,
      );
    }
  }
  return buildCustomModelDef({
    repoId: ref.repoId,
    revision: ref.revision,
    file,
    mmproj: pickMmprojFile(files),
  });
}
