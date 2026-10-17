import { setTimeout as delay } from "node:timers/promises";
import type { DownloadFileOptions } from "../downloads/download-file.js";
import { acquireCoreLease, connectCore, CoreRequestError, ensureCore, type CoreControlClient } from "./core-client.js";
import { shutdownIdleCoreClient } from "./core-idle.js";
import { installCore, isCoreInstalled } from "./core-install.js";
import { withCoreOperation } from "./core-operation.js";
import { activeCoreVersion, CORE_VERSION, coreDataDir } from "./core-state.js";

/**
 * Image generation through Atomic Core's diffusion jobs (Core 0.15+):
 * `POST /atomic/v1/diffusion/jobs`, then the job is polled until it
 * settles. A local job runs on the stable-diffusion.cpp model Core has
 * loaded; a job with `target` goes to a cloud provider registered with
 * `PUT /cloud/providers/:id` (no engine, no GPU). Either way Core writes
 * the result under its own data folder and answers with the file path.
 *
 * Generation always runs on this build's Core pin: older pins have no
 * cloud media. A cloud-only user who never installed Core gets the Core
 * binary alone (no inference backend), as decided for ATO-410.
 */

export const OPENROUTER_MEDIA_BASE_URL = "https://openrouter.ai/api/v1";
/** Used when Core's media catalog cannot be read; the catalog's own default since Core 0.16.0. */
export const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-nano-banana-2.1";

export interface CoreImageTarget { provider: string; model: string }

/** Core's `ImageGenerateRequest`, the fields the agent sends. */
export interface CoreImageRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  batchSize: number;
  /** Absent: Core draws one. */
  seed?: number;
  target?: CoreImageTarget;
  remote?: { aspectRatio?: string; resolution?: string; outputFormat?: string };
}

export type CoreImageJobState = "queued" | "generating" | "completed" | "failed" | "cancelled";

export interface CoreImageProgress {
  phase?: string;
  step: number;
  totalSteps: number;
  fraction: number;
  etaSeconds: number | null;
}

export interface CoreImageOutput { id: string; path: string; width: number; height: number; sizeBytes: number }

export interface CoreImageJob {
  id: string;
  state: CoreImageJobState;
  modelId?: string;
  progress?: CoreImageProgress;
  outputs: CoreImageOutput[];
  error?: { code: string; message: string; details?: string };
}

/** One entry of `GET /media/providers/:p/models?kind=image`. */
export interface CoreMediaModel {
  id: string;
  name?: string;
  default?: boolean;
  params?: {
    aspect_ratios?: { values?: string[]; default?: string };
    n?: { max?: number };
    seed?: boolean;
  };
}

/**
 * A generation that failed, with Core's code when it gave one
 * (`JOB_BUSY`, `GPU_BUSY`, `MODEL_NOT_LOADED`, `REMOTE_AUTH_FAILED`, ...).
 * `message` is a sentence a person can act on.
 */
export class CoreImageError extends Error {
  override readonly name = "CoreImageError";
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) { super(message, options); }
}

const TERMINAL: ReadonlySet<CoreImageJobState> = new Set(["completed", "failed", "cancelled"]);
const POLL_MS = 1_000;
/** Core's remote adapters give up after 10 minutes; a local job on a slow GPU may take longer. */
export const CORE_IMAGE_TIMEOUT_MS = { cloud: 11 * 60_000, local: 20 * 60_000 } as const;

/** Core's refusal codes in words a person can act on. Unknown codes keep Core's own message. */
export function describeCoreImageError(code: string | undefined, message: string, cloud: boolean): string {
  const why = message.replace(/\.$/, "");
  switch (code) {
    case "JOB_BUSY":
      return cloud
        ? "Atomic Core is already running 4 cloud image jobs. Wait for one to finish and try again."
        : "Atomic Core is already generating an image. Wait for it to finish and try again.";
    case "GPU_BUSY":
      return "The graphics card is busy with another model. Wait for it to finish, or stop the local model, and try again.";
    case "NOT_CONFIGURED":
      return `Atomic Core's image generation is not set up (${why}).`;
    case "MODEL_NOT_LOADED":
    case "MODEL_MISSING":
    case "ENGINE_MISSING":
      return "No local image model is loaded in Atomic Core. Add an OpenRouter key to generate images in the cloud.";
    case "OUT_OF_MEMORY":
      return "The image model ran out of memory. Try a smaller size or fewer images.";
    case "QUEUE_FULL":
      return "Atomic Core's image queue is full. Try again in a moment.";
    case "REMOTE_NOT_CONFIGURED":
      return "The cloud image provider is not set up in Atomic Core. Check that an OpenRouter key is configured.";
    case "REMOTE_AUTH_FAILED":
      return "OpenRouter refused the API key. Check the key in your provider settings.";
    case "REMOTE_QUOTA":
      return "OpenRouter says the account is out of credits. Top up at openrouter.ai and try again.";
    case "REMOTE_RATE_LIMITED":
      return "OpenRouter is rate limiting image requests. Try again in a minute.";
    case "REMOTE_CONTENT_BLOCKED":
      return `The image model refused this prompt (${why}). Rephrase it and try again.`;
    case "REMOTE_REJECTED":
    case "REMOTE_UNSUPPORTED":
      return `The image model rejected the request (${why}).`;
    case "REMOTE_TIMEOUT":
      return "The image model did not answer in time. Try again.";
    case "REMOTE_UNAVAILABLE":
      return `The cloud image provider is unavailable right now (${why}). Try again later.`;
    case "INVALID_REQUEST":
    case "INVALID_DIMENSIONS":
      return `Atomic Core rejected the image request (${why}).`;
    default:
      return `Image generation failed: ${why}.`;
  }
}

function toImageError(err: unknown, cloud: boolean): unknown {
  if (err instanceof CoreRequestError) {
    return new CoreImageError(describeCoreImageError(err.code, err.message, cloud), err.code ?? "HTTP_ERROR", { cause: err });
  }
  return err;
}

/**
 * Register OpenRouter with Core's cloud media. The key is passed only
 * here, never through Core's environment (`core-env.ts`). Core replaces
 * `base_url`, `models` and `custom_headers` whole on every PUT; the agent
 * uses its own Core only for media, so nothing else is lost.
 */
export async function registerOpenRouterMedia(client: CoreControlClient, apiKey: string, signal?: AbortSignal): Promise<void> {
  try {
    await client.call("/cloud/providers/openrouter", {
      api_key: apiKey,
      base_url: OPENROUTER_MEDIA_BASE_URL,
      custom_headers: [],
      models: [],
      media: { image_api: "openrouter-images", models: [] },
    }, { method: "PUT", ...(signal ? { signal } : {}) });
  } catch (err) { throw toImageError(err, true); }
}

/** Core's image models for a provider (catalog merged with the provider's live list). Empty when Core cannot say. */
export async function listCoreImageModels(client: CoreControlClient, provider: string, signal?: AbortSignal): Promise<CoreMediaModel[]> {
  try {
    const answer = await client.call<{ models?: CoreMediaModel[] }>(`/media/providers/${encodeURIComponent(provider)}/models?kind=image`, undefined, { ...(signal ? { signal } : {}), timeoutMs: 20_000 });
    return Array.isArray(answer.models) ? answer.models.filter(m => typeof m?.id === "string" && m.id.length > 0) : [];
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

/** The catalog's default model, else its first, else the pinned fallback. */
export function defaultImageModel(models: readonly CoreMediaModel[], fallback = DEFAULT_OPENROUTER_IMAGE_MODEL): string {
  return models.find(m => m.default)?.id ?? models[0]?.id ?? fallback;
}

/** Point Core's local diffusion at its own data folder (required before a local job). */
export async function configureCoreDiffusion(client: CoreControlClient, dataFolder: string, signal?: AbortSignal): Promise<void> {
  try {
    await client.call("/diffusion/config", { dataFolder }, { method: "PUT", ...(signal ? { signal } : {}) });
  } catch (err) { throw toImageError(err, false); }
}

export interface RunCoreImageJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CoreImageProgress) => void;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Submit one job and wait for it to settle. The submit is never retried:
 * a cloud provider would bill twice. Abort (Esc) and the timeout cancel
 * the job in Core. A completed job with no files is a failure.
 */
export async function runCoreImageJob(client: CoreControlClient, request: CoreImageRequest, opts: RunCoreImageJobOptions = {}): Promise<CoreImageJob> {
  const cloud = request.target !== undefined;
  const timeoutMs = opts.timeoutMs ?? (cloud ? CORE_IMAGE_TIMEOUT_MS.cloud : CORE_IMAGE_TIMEOUT_MS.local);
  let jobId: string;
  try {
    const answer = await client.call<{ jobId?: unknown }>("/diffusion/jobs", request, { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 60_000 });
    if (typeof answer.jobId !== "string" || answer.jobId.length === 0) throw new CoreImageError("Atomic Core did not return an image job id.", "BAD_ANSWER");
    jobId = answer.jobId;
  } catch (err) { throw toImageError(err, cloud); }

  const cancel = () => client.call(`/diffusion/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { timeoutMs: 5_000 }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let misses = 0;
  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      if (Date.now() > deadline) {
        await cancel();
        throw new CoreImageError(`The image was not ready after ${Math.round(timeoutMs / 60_000)} minutes, so the job was cancelled.`, "TIMEOUT");
      }
      let job: CoreImageJob | null;
      try {
        job = (await client.call<{ job: CoreImageJob | null }>(`/diffusion/jobs/${encodeURIComponent(jobId)}`, undefined, { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 15_000 })).job;
        misses = 0;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // A dropped poll is not a failed job; give up only when Core stays unreachable.
        if (++misses >= 5) {
          await cancel();
          throw new CoreImageError("Atomic Core stopped answering while the image was being made.", "CORE_UNREACHABLE", { cause: err });
        }
        await delay(opts.pollMs ?? POLL_MS, undefined, opts.signal ? { signal: opts.signal } : {});
        continue;
      }
      // Core keeps only its last 50 jobs in memory.
      if (!job) throw new CoreImageError("Atomic Core lost track of the image job.", "JOB_NOT_FOUND");
      if (job.progress) opts.onProgress?.(job.progress);
      if (TERMINAL.has(job.state)) {
        if (job.state === "completed") {
          const outputs = (job.outputs ?? []).filter(o => typeof o?.path === "string" && o.path.length > 0);
          if (outputs.length === 0) throw new CoreImageError("The image job finished without a picture.", "NO_OUTPUT");
          return { ...job, outputs };
        }
        if (job.state === "cancelled") throw new CoreImageError("The image job was cancelled.", "CANCELLED");
        throw new CoreImageError(describeCoreImageError(job.error?.code, job.error?.message ?? "unknown error", cloud), job.error?.code ?? "FAILED");
      }
      await delay(opts.pollMs ?? POLL_MS, undefined, opts.signal ? { signal: opts.signal } : {});
    }
  } catch (err) {
    if (opts.signal?.aborted) await cancel();
    throw err;
  }
}

export interface WithImageCoreOptions {
  signal?: AbortSignal;
  /** The Core binary is about to be downloaded (first image on a computer without Core). */
  onCoreInstall?: () => void;
  onCoreProgress?: DownloadFileOptions["onProgress"];
  /** How long to wait for another engine operation (a model load holds it up to 4 minutes). */
  waitMs?: number;
}

/** A chat model load holds the engine lock for up to 240 s; a picture waits that out. */
export const IMAGE_CORE_WAIT_MS = 5 * 60_000;

/** Whether the first picture on this computer downloads the Core binary first. */
export function imageCoreNeedsInstall(dataDir: string): boolean {
  return !isCoreInstalled(dataDir, CORE_VERSION);
}

/**
 * Run `fn` on a started Core of this build's pin, holding a client lease
 * for the whole generation. Install (the Core binary alone, no inference
 * backend), start and lease happen under the engine operation lock: two
 * first pictures, or one beside a backend install, share the download's
 * staging file, and another window's idle-Core stop must not land between
 * the start and the lease. The generation itself runs outside the lock,
 * so it never blocks a model load for minutes.
 *
 * A Core this call started (none was running), or one beside an older
 * active pin, is shut down again when idle: on a cloud route nothing else
 * would stop it (quit and idle stops look only at the active version, and
 * only for the Atomic Core engine), and it outlived the app in the live
 * check. One that was already running for a model is left alone, and Core
 * itself refuses while a model session or another client remains.
 */
export async function withImageCore<T>(dataDir: string, fn: (client: CoreControlClient, dataFolder: string) => Promise<T>, opts: WithImageCoreOptions = {}): Promise<T> {
  const version = CORE_VERSION;
  const { client, lease, startedHere } = await withCoreOperation(dataDir, async () => {
    const running = await connectCore(dataDir, version).catch(() => null);
    if (!isCoreInstalled(dataDir, version)) {
      opts.onCoreInstall?.();
      await installCore(dataDir, version, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onCoreProgress ? { onProgress: opts.onCoreProgress } : {}),
      });
    }
    const started = await ensureCore(dataDir, version, opts.signal);
    return { client: started, lease: await acquireCoreLease(started), startedHere: running === null };
  }, { waitMs: opts.waitMs ?? IMAGE_CORE_WAIT_MS });
  try { return await fn(client, coreDataDir(dataDir, version)); }
  finally {
    await lease.release();
    if (startedHere || activeCoreVersion(dataDir) !== version) {
      await withCoreOperation(dataDir, () => shutdownIdleCoreClient(client), { waitMs: 2_000 }).catch(() => false);
    }
  }
}
