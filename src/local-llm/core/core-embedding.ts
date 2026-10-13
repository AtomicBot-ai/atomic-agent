import { existsSync, unlinkSync } from "node:fs";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import {
  EmbeddingUnavailableError,
  promptedEmbeddingText,
  type EmbedRequest,
  type EmbedResult,
  type EmbeddingClient,
  type EmbeddingPrompts,
} from "../../memory/embeddings/embedding-client.js";
import { activateCoreVersion, installSelectedBackend, isCoreBackendInstalled } from "./core-backend.js";
import { connectCore, CoreRequestError, withCoreClient, type CoreControlClient } from "./core-client.js";
import { CORE_OPERATION_WAIT_MS, withCoreOperation } from "./core-operation.js";
import { retireIdleCore } from "./core-sessions.js";
import {
  activeCoreVersion,
  CORE_VERSION,
  coreEmbeddingRecordPath,
  readCoreEmbeddingRecord,
  writeCoreJson,
  type CoreEmbeddingRecord,
} from "./core-state.js";

// The record lives with the other Core state so Core start can apply a pending stop.
export { coreEmbeddingRecordPath, readCoreEmbeddingRecord, type CoreEmbeddingRecord } from "./core-state.js";

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

function markDisablePending(dataDir: string, record: CoreEmbeddingRecord): void {
  writeCoreJson(coreEmbeddingRecordPath(dataDir), { ...record, disablePending: true } satisfies CoreEmbeddingRecord);
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
 * Which stock llama.cpp build serves a model that needs `minBuild`.
 * `available` and `recommended` are already gated by Core for this
 * hardware (it maps its family ids, `win-cuda-13-x64`, onto concrete
 * builds, `win-cuda-13.1-x64`), so they are trusted as they are, and an
 * installed build counts only when it is also in `available`. An
 * installed build at or above the floor wins; otherwise Core's
 * recommendation when it is new enough, else the newest available build
 * at or above the floor, the recommended backend kind first. Pure.
 */
export function chooseUpstreamEngine(catalog: UpstreamCatalog, minBuild: number): UpstreamEngineChoice {
  const available = catalog.available ?? [];
  const runnable = (b: UpstreamBuild) => available.some(a => a.version === b.version && a.backend === b.backend);
  const newEnough = (b: UpstreamBuild) => (upstreamBuildNumber(b.version) ?? -1) >= minBuild;
  const newestFirst = (a: UpstreamBuild, b: UpstreamBuild) => (upstreamBuildNumber(b.version) ?? 0) - (upstreamBuildNumber(a.version) ?? 0);

  const installed = (catalog.installed ?? []).filter(b => newEnough(b) && runnable(b)).sort(newestFirst)[0];
  if (installed) return { kind: "installed", version: installed.version, backend: installed.backend };

  const [tag, backend, extra] = (catalog.recommended ?? "").split("/");
  const recommended = tag && backend && !extra ? { version: tag, backend } : null;
  if (recommended && newEnough(recommended)) return { kind: "install", ...recommended };

  const candidates = available.filter(newEnough);
  candidates.sort((a, b) => newestFirst(a, b) || Number(b.backend === recommended?.backend) - Number(a.backend === recommended?.backend));
  const pick = candidates[0];
  return pick ? { kind: "install", version: pick.version, backend: pick.backend } : { kind: "none" };
}

/**
 * Install a stock llama.cpp build the module can use, when none is.
 * Returns the `<tag>/<backend>` and whether it was installed now; a build
 * that was already there and still refused by Core is not reinstalled.
 */
export async function installCoreEmbeddingEngine(client: CoreControlClient, opts: DownloadFileOptions = {}, minBuild = CORE_EMBEDDING_MIN_BUILD): Promise<{ build: string; installedNow: boolean }> {
  const catalog = await client.call<UpstreamCatalog>(`/backends/${UPSTREAM}/catalog`, {}, { signal: opts.signal, timeoutMs: 60_000 });
  const choice = chooseUpstreamEngine(catalog, minBuild);
  if (choice.kind === "none") {
    throw new Error(`No llama.cpp build b${minBuild} or newer is published for this computer, so the embedding model cannot run here yet.`);
  }
  const build = `${choice.version}/${choice.backend}`;
  if (choice.kind === "installed") return { build, installedNow: false };
  await installSelectedBackend(client, UPSTREAM, { version: choice.version, backend: choice.backend }, opts);
  return { build, installedNow: true };
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
      return new Error(`Atomic Core found no llama.cpp build that runs ${modelId} (${why}). Check your connection and retry with: atomic-agent models start-embedding`, { cause: err });
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
 * installed once and the load retried. Leaves the module configured on
 * failure: `startCoreEmbedding` turns it off again.
 */
export async function startCoreEmbeddingOn(client: CoreControlClient, opts: CoreEmbeddingStartOptions): Promise<CoreEmbeddingStatus> {
  const load = () => client.call<CoreEmbeddingStatus>("/embedding/load", {}, { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 180_000 });
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
    const engine = await installCoreEmbeddingEngine(client, {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onEngineProgress ? { onProgress: opts.onEngineProgress } : {}),
    }, opts.minBuild);
    if (!engine.installedNow) {
      // Installing again would change nothing: say so instead of a retry hint that loops.
      throw new Error(`Atomic Core refused llama.cpp ${engine.build} for ${opts.modelId} (${err.message.replace(/\.$/, "")}). Update the engine with: atomic-agent models update, and report it if this persists.`, { cause: err });
    }
    status = await load();
  }
  if (status.state !== "ready" || !Number.isInteger(status.dims) || status.model_id !== opts.modelId) {
    throw new Error(`Atomic Core reported the embedding model as ${status.state}${status.error ? ` (${status.error.message})` : ""}.`);
  }
  return status;
}

/** Turn the module off on a connected Core; false when Core refused or did not answer. */
async function disableOn(client: CoreControlClient, timeoutMs: number): Promise<boolean> {
  return client.call("/embedding/config", { enabled: false }, { method: "PUT", timeoutMs }).then(() => true, () => false);
}

/**
 * The module needs Core with the embedding module (this build's pin). An
 * older active Core is switched when nothing runs on it; otherwise the
 * sentence says what to do.
 */
async function moduleCoreVersion(dataDir: string): Promise<string> {
  if (activeCoreVersion(dataDir) === CORE_VERSION) return CORE_VERSION;
  if (await activateCoreVersion(dataDir, CORE_VERSION)) return CORE_VERSION;
  throw new Error(isCoreBackendInstalled(dataDir, CORE_VERSION)
    ? `The embedding model needs Atomic Core ${CORE_VERSION}, which is installed but waits until local models stop. Run: atomic-agent models stop, then start again.`
    : `The embedding model needs Atomic Core ${CORE_VERSION}. Install it with: atomic-agent models update`);
}

/**
 * `models start-embedding` for a model that runs in Core's embedding
 * module: install an engine when needed, load the model, record it.
 * Serialized with every other engine operation. On any failure
 * (cancellation included) the module is turned off again, so Core has
 * nothing to retry in the background; if Core will not take that change,
 * the record stays with the change pending.
 */
export async function startCoreEmbedding(dataDir: string, opts: CoreEmbeddingStartOptions): Promise<CoreEmbeddingStatus> {
  const version = await moduleCoreVersion(dataDir);
  return withCoreOperation(dataDir, async () => {
    return withCoreClient(dataDir, version, async client => {
      const record: CoreEmbeddingRecord = { coreVersion: version, modelId: opts.modelId, modelPath: opts.modelPath };
      // Recorded first: a start interrupted after Core enabled the module is still stoppable.
      writeCoreJson(coreEmbeddingRecordPath(dataDir), record);
      try { return await startCoreEmbeddingOn(client, opts); }
      catch (err) {
        if (await disableOn(client, 30_000)) dropCoreEmbeddingRecord(dataDir);
        else markDisablePending(dataDir, record);
        if (opts.signal?.aborted) throw err;
        throw describeCoreEmbeddingError(err, opts.modelId);
      }
    }, opts.signal);
  });
}

/**
 * Turn the module off (`enabled: false`, so Core neither keeps it nor
 * starts it at its next launch) and forget the record. False when this
 * agent never started it. A Core that is not running is never started for
 * this: the record is marked `disablePending` and the next Core start
 * applies it (`applyPendingEmbeddingDisable`). A refused change also stays
 * pending, and the stop fails. After a change on a running Core, an idle
 * Core is retired unless `retire: false`. `waitMs` bounds both the wait
 * for another engine operation and Core's answer (at least 5 s).
 */
export async function stopCoreEmbedding(dataDir: string, opts: { waitMs?: number; retire?: boolean } = {}): Promise<boolean> {
  if (!existsSync(coreEmbeddingRecordPath(dataDir))) return false;
  const waitMs = opts.waitMs ?? CORE_OPERATION_WAIT_MS;
  const touched = await withCoreOperation(dataDir, async () => {
    const record = readCoreEmbeddingRecord(dataDir);
    if (!record) { dropCoreEmbeddingRecord(dataDir); return false; }
    const client = await connectCore(dataDir, record.coreVersion).catch(() => null);
    if (!client) { markDisablePending(dataDir, record); return false; }
    if (!(await disableOn(client, Math.max(waitMs, 5_000)))) {
      markDisablePending(dataDir, record);
      throw new Error("Atomic Core did not turn the embedding model off; it is retried at the next engine start.");
    }
    dropCoreEmbeddingRecord(dataDir);
    return true;
  }, { waitMs });
  if (touched && opts.retire !== false) await retireIdleCore(dataDir);
  return true;
}

/** The module's status on the recorded Core, without starting it; null when it is not running or never started. */
export async function coreEmbeddingStatus(dataDir: string, connect: typeof connectCore = connectCore): Promise<CoreEmbeddingStatus | null> {
  const record = readCoreEmbeddingRecord(dataDir);
  if (!record || record.disablePending) return null;
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
  /**
   * Per request; default `coreEmbeddingTimeoutMs(purpose)`. Set, it
   * applies to every purpose.
   */
  timeoutMs?: number;
  /** Connect to the running Core without starting it. Default: the recorded Core. */
  connect?: () => Promise<CoreControlClient | null>;
}

/**
 * How long one embed waits. Core starts an idle module on the request and
 * waits up to its `startup_timeout_secs` (120 s) for it, so a document
 * write (in the background) waits that long plus the answer. A recall
 * query or a gate check blocks the user's turn and falls back to FTS5
 * cheaply, while Core keeps starting the module for the next one: those
 * stay short.
 */
export function coreEmbeddingTimeoutMs(purpose: EmbedRequest["purpose"]): number {
  return purpose === "query" || purpose === "similarity" ? 15_000 : 130_000;
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
          { ...(req.signal ? { signal: req.signal } : {}), timeoutMs: opts.timeoutMs ?? coreEmbeddingTimeoutMs(req.purpose) });
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
