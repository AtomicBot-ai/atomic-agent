import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import {
  EmbeddingUnavailableError,
  promptedEmbeddingText,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingClient,
  type EmbeddingPrompts,
} from "../../memory/embeddings/embedding-client.js";
import { installSelectedBackend } from "./core-backend.js";
import { connectCore, CoreRequestError, ensureCore, withCoreClient, type CoreControlClient } from "./core-client.js";
import { withCoreOperation } from "./core-operation.js";
import { activeCoreVersion, CORE_VERSIONS, coreRoot, readCoreJson, writeCoreJson } from "./core-state.js";

/**
 * Atomic Core's embedding module (Core 0.13+): one stock llama.cpp
 * `llama-server --embedding` that Core runs outside its model sessions,
 * driven through the control API only (`/atomic/v1/embedding/*`). It is
 * for embedding models the TurboQuant fork that serves chat cannot run
 * (`EmbeddingModelDef.requiresCoreEmbeddingModule`). Core never downloads
 * an engine for it by itself; `startCoreEmbedding` installs a stock
 * llama.cpp build new enough for the model when Core reports none.
 */

/** The first stock llama.cpp build that runs `gemma-embedding2` (EmbeddingGemma 2, ggml-org/llama.cpp#30054). */
export const CORE_EMBEDDING_MIN_BUILD = 11454;

const UPSTREAM = "llamacpp-upstream";

export type CoreEmbeddingState = "disabled" | "idle" | "starting" | "ready" | "restarting" | "failed" | "unsupported";

/** Core's `EmbeddingStatus`, as `GET /embedding/status` answers it. */
export interface CoreEmbeddingStatus {
  state: CoreEmbeddingState;
  enabled: boolean;
  model_path: string | null;
  model_id: string | null;
  engine: { path: string; version_backend: string | null; provider: string | null } | null;
  pid: number | null;
  port: number | null;
  /** Length of the vectors the running process returns; `null` until ready. */
  dims: number | null;
  modalities: string[];
  restarts: number;
  error: { code: string; message: string; details?: string } | null;
  since: number;
}

/**
 * What this agent turned on in Core, so status and stop find the module
 * without starting Core (`core/embedding-module.json`). The module has no
 * pid or port file of its own: Core owns its process.
 */
export interface CoreEmbeddingRecord {
  coreVersion: string;
  modelId: string;
  modelPath: string;
}

export function coreEmbeddingRecordPath(dataDir: string): string {
  return join(coreRoot(dataDir), "embedding-module.json");
}

export function readCoreEmbeddingRecord(dataDir: string): CoreEmbeddingRecord | null {
  const record = readCoreJson<CoreEmbeddingRecord>(coreEmbeddingRecordPath(dataDir));
  if (!record || typeof record.modelId !== "string" || typeof record.modelPath !== "string") return null;
  return CORE_VERSIONS.includes(record.coreVersion as typeof CORE_VERSIONS[number]) ? record : null;
}

function dropCoreEmbeddingRecord(dataDir: string): void {
  try { unlinkSync(coreEmbeddingRecordPath(dataDir)); } catch { /* already gone */ }
}

/** The module is up or on its way up (a crash restart included). */
export function coreEmbeddingRunning(status: Pick<CoreEmbeddingStatus, "state">): boolean {
  return status.state === "ready" || status.state === "starting" || status.state === "restarting";
}

// ---------------------------------------------------------------------
// Engine selection: a stock llama.cpp build at or above the model's floor.
// ---------------------------------------------------------------------

interface UpstreamBuild { version: string; backend: string }

/** The parts of Core's `POST /backends/llamacpp-upstream/catalog` answer this module reads. */
export interface UpstreamCatalog {
  supported_backends?: string[];
  installed?: UpstreamBuild[];
  available?: UpstreamBuild[];
  recommended?: string | null;
}

export type UpstreamEngineChoice =
  /** A build at or above the floor is already installed: nothing to download. */
  | { kind: "installed"; version: string; backend: string }
  | { kind: "install"; version: string; backend: string }
  | { kind: "none" };

/** `b11454` → 11454; any other tag (a fork or a sentinel) → undefined. */
export function upstreamBuildNumber(version: string): number | undefined {
  const match = /^b(\d+)$/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Which stock llama.cpp build serves a model that needs `minBuild`. An
 * installed build this computer can run wins. Otherwise Core's own
 * recommendation when it is new enough, else the newest available build
 * at or above the floor, the recommended backend kind first (Core picked
 * it for this hardware). Pure.
 */
export function chooseUpstreamEngine(catalog: UpstreamCatalog, minBuild: number): UpstreamEngineChoice {
  const supported = new Set(catalog.supported_backends ?? []);
  const runnable = (b: UpstreamBuild) => supported.size === 0 || supported.has(b.backend);
  const newEnough = (b: UpstreamBuild) => (upstreamBuildNumber(b.version) ?? -1) >= minBuild;
  const newestFirst = (a: UpstreamBuild, b: UpstreamBuild) => (upstreamBuildNumber(b.version) ?? 0) - (upstreamBuildNumber(a.version) ?? 0);

  const installed = (catalog.installed ?? []).filter(b => newEnough(b) && runnable(b)).sort(newestFirst)[0];
  if (installed) return { kind: "installed", version: installed.version, backend: installed.backend };

  const [tag, backend, extra] = (catalog.recommended ?? "").split("/");
  const recommended = tag && backend && !extra ? { version: tag, backend } : null;
  if (recommended && newEnough(recommended) && runnable(recommended)) return { kind: "install", ...recommended };

  const candidates = (catalog.available ?? []).filter(b => newEnough(b) && runnable(b));
  candidates.sort((a, b) => newestFirst(a, b) || Number(b.backend === recommended?.backend) - Number(a.backend === recommended?.backend));
  const pick = candidates[0];
  return pick ? { kind: "install", version: pick.version, backend: pick.backend } : { kind: "none" };
}

/**
 * Install a stock llama.cpp build the module can use, when none is.
 * Returns the `<tag>/<backend>` installed, or null when one already was
 * (Core refused it, so installing changes nothing).
 */
export async function installCoreEmbeddingEngine(client: CoreControlClient, opts: DownloadFileOptions = {}, minBuild = CORE_EMBEDDING_MIN_BUILD): Promise<string | null> {
  const catalog = await client.call<UpstreamCatalog>(`/backends/${UPSTREAM}/catalog`, {}, { signal: opts.signal, timeoutMs: 60_000 });
  const choice = chooseUpstreamEngine(catalog, minBuild);
  if (choice.kind === "installed") return null;
  if (choice.kind === "none") {
    throw new Error(`No llama.cpp build b${minBuild} or newer is published for this computer, so the embedding model cannot run here yet.`);
  }
  await installSelectedBackend(client, UPSTREAM, { version: choice.version, backend: choice.backend }, opts);
  return `${choice.version}/${choice.backend}`;
}

// ---------------------------------------------------------------------
// Start, stop, status.
// ---------------------------------------------------------------------

/** A Core refusal in words a person can act on. */
export function describeCoreEmbeddingError(err: unknown, modelId: string): Error {
  if (!(err instanceof CoreRequestError)) return err instanceof Error ? err : new Error(String(err));
  const why = err.message.replace(/\.$/, "");
  switch (err.code) {
    case "MODEL_FILE_NOT_FOUND":
      return new Error(`embedding model ${modelId} not downloaded; run 'atomic-agent models pull-embedding ${modelId}'`, { cause: err });
    case "EMBEDDING_ENGINE_UNSUPPORTED":
      return new Error(`Atomic Core found no llama.cpp build that runs ${modelId} (${why}). Retry with: atomic-agent models start-embedding`, { cause: err });
    case "EMBEDDING_MODEL_NOT_EMBEDDING":
      return new Error(`The ${modelId} file is not an embedding model (${why}). Remove it and pull it again.`, { cause: err });
    case "EMBEDDING_UNAVAILABLE":
      return new Error(`Atomic Core has no embedding module; update the engine with: atomic-agent models update (${why}).`, { cause: err });
    default:
      if (err.status === 404) return new Error("This Atomic Core has no embedding module; update the engine with: atomic-agent models update.", { cause: err });
      return new Error(`Atomic Core could not start the embedding model: ${why}.`, { cause: err });
  }
}

export interface CoreEmbeddingStartOptions {
  modelId: string;
  /** Absolute path of the downloaded GGUF. */
  modelPath: string;
  signal?: AbortSignal;
  /** Download progress of a llama.cpp build installed for the model. */
  onEngineProgress?: DownloadFileOptions["onProgress"];
  /** A llama.cpp build is about to be installed for the model. */
  onEngineInstall?: () => void;
  minBuild?: number;
}

/**
 * Configure and load the module on a connected Core. A missing engine is
 * installed once and the load retried. On any failure (cancellation
 * included) the module is turned off again, so a failed start leaves
 * nothing for Core to retry in the background.
 */
export async function startCoreEmbeddingOn(client: CoreControlClient, opts: CoreEmbeddingStartOptions): Promise<CoreEmbeddingStatus> {
  const load = () => client.call<CoreEmbeddingStatus>("/embedding/load", {}, { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 180_000 });
  try {
    opts.signal?.throwIfAborted();
    await client.call("/embedding/config", {
      enabled: true, model_path: opts.modelPath, model_id: opts.modelId,
      mmproj_path: "", ctx_size: 2048, pooling: "",
    }, { method: "PUT", ...(opts.signal ? { signal: opts.signal } : {}) });
    let status: CoreEmbeddingStatus;
    try { status = await load(); }
    catch (err) {
      if (!(err instanceof CoreRequestError) || err.code !== "EMBEDDING_ENGINE_UNSUPPORTED") throw err;
      opts.onEngineInstall?.();
      const installed = await installCoreEmbeddingEngine(client, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onEngineProgress ? { onProgress: opts.onEngineProgress } : {}),
      }, opts.minBuild);
      if (installed === null) throw err;
      status = await load();
    }
    if (status.state !== "ready" || !Number.isInteger(status.dims) || status.model_id !== opts.modelId) {
      throw new Error(`Atomic Core reported the embedding model as ${status.state}${status.error ? ` (${status.error.message})` : ""}.`);
    }
    return status;
  } catch (err) {
    await client.call("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 }).catch(() => {});
    if (opts.signal?.aborted) throw err;
    throw describeCoreEmbeddingError(err, opts.modelId);
  }
}

/**
 * `models start-embedding` for a model that runs in Core's embedding
 * module: install an engine when needed, load the model, record it.
 * Serialized with every other engine operation.
 */
export async function startCoreEmbedding(dataDir: string, opts: CoreEmbeddingStartOptions): Promise<CoreEmbeddingStatus> {
  return withCoreOperation(dataDir, async () => {
    const version = activeCoreVersion(dataDir);
    return withCoreClient(dataDir, version, async client => {
      // Recorded first: a start interrupted after Core enabled the module is still stoppable.
      writeCoreJson(coreEmbeddingRecordPath(dataDir), { coreVersion: version, modelId: opts.modelId, modelPath: opts.modelPath } satisfies CoreEmbeddingRecord);
      try { return await startCoreEmbeddingOn(client, opts); }
      catch (err) { dropCoreEmbeddingRecord(dataDir); throw err; }
    }, opts.signal);
  });
}

/**
 * Turn the module off (`enabled: false`, so Core neither keeps it nor
 * starts it at its next launch) and forget the record. False when this
 * agent never started it. A Core that is not running is started for the
 * change; the caller's idle retirement stops it again.
 */
export async function stopCoreEmbedding(dataDir: string, opts: { waitMs?: number } = {}): Promise<boolean> {
  if (!existsSync(coreEmbeddingRecordPath(dataDir))) return false;
  return withCoreOperation(dataDir, async () => {
    const record = readCoreEmbeddingRecord(dataDir);
    if (!record) { dropCoreEmbeddingRecord(dataDir); return true; }
    let client = await connectCore(dataDir, record.coreVersion).catch(() => null);
    if (!client) {
      try { client = await ensureCore(dataDir, record.coreVersion); }
      // Core cannot start (removed, broken): nothing of it can run the module either.
      catch { dropCoreEmbeddingRecord(dataDir); return true; }
    }
    await client.call("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs: 30_000 });
    dropCoreEmbeddingRecord(dataDir);
    return true;
  }, opts);
}

/** The module's status on the recorded Core, without starting it; null when it is not running or never started. */
export async function coreEmbeddingStatus(dataDir: string, connect: typeof connectCore = connectCore): Promise<CoreEmbeddingStatus | null> {
  const record = readCoreEmbeddingRecord(dataDir);
  if (!record) return null;
  try {
    const client = await connect(dataDir, record.coreVersion);
    return client ? await client.call<CoreEmbeddingStatus>("/embedding/status") : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------
// The memory client.
// ---------------------------------------------------------------------

export interface CoreEmbeddingClientOptions {
  dataDir: string;
  dim: number;
  /** The catalog id: the `memory_embeddings.model` column and the module's `model_id`. */
  model: string;
  prompts?: EmbeddingPrompts;
  /** Per request. An idle module starts on the first one, so allow for a load. */
  timeoutMs?: number;
  /** Connect to the running Core without starting it. Default: the recorded Core. */
  connect?: () => Promise<CoreControlClient | null>;
}

/**
 * An `EmbeddingClient` over `POST /atomic/v1/embedding/embed`. The
 * control connection is reused across calls and rebuilt after a
 * failure; it never starts Core. Every failure is an
 * `EmbeddingUnavailableError`, so memory falls back to FTS5.
 */
export function createCoreEmbeddingClient(opts: CoreEmbeddingClientOptions): EmbeddingClient {
  if (!Number.isInteger(opts.dim) || opts.dim <= 0) throw new Error(`createCoreEmbeddingClient: dim must be a positive integer, got ${opts.dim}`);
  const connect = opts.connect ?? (async () => {
    const record = readCoreEmbeddingRecord(opts.dataDir);
    return connectCore(opts.dataDir, record?.coreVersion ?? activeCoreVersion(opts.dataDir));
  });
  let connected: CoreControlClient | null = null;
  return {
    dim: opts.dim,
    model: opts.model,
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      let answer: { status: number; body: unknown };
      try {
        connected ??= await connect();
        if (!connected) throw new EmbeddingUnavailableError("Atomic Core is not running");
        answer = await connected.call<{ status: number; body: unknown }>("/embedding/embed",
          { model: opts.model, input: promptedEmbeddingText(req, opts.prompts) },
          { ...(req.signal ? { signal: req.signal } : {}), timeoutMs: opts.timeoutMs ?? 30_000 });
      } catch (err) {
        connected = null;
        if (err instanceof EmbeddingUnavailableError) throw err;
        throw new EmbeddingUnavailableError(`embedding request failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }
      if (answer.status !== 200) {
        const message = (answer.body as { error?: { message?: unknown } } | null)?.error?.message;
        throw new EmbeddingUnavailableError(`embedding model returned HTTP ${answer.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`);
      }
      const raw = (answer.body as { data?: Array<{ embedding?: unknown }> } | null)?.data?.[0]?.embedding;
      if (!Array.isArray(raw) || !raw.every(v => typeof v === "number")) {
        throw new EmbeddingUnavailableError("embedding model response shape unrecognised");
      }
      if (raw.length !== opts.dim) throw new EmbeddingUnavailableError(`embedding dim mismatch: expected ${opts.dim}, got ${raw.length}`);
      return { vector: Float32Array.from(raw as number[]), model: opts.model };
    },
  };
}
