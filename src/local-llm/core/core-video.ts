import { setTimeout as delay } from "node:timers/promises";
import { CoreRequestError, type CoreControlClient } from "./core-client.js";

/**
 * Video generation through Atomic Core's video jobs (`src/server/control/routes/diffusion-video.ts`
 * in atomic-chat-core; the same at v0.16.0 and v0.18.6):
 *
 * - `POST /atomic/v1/diffusion/video/jobs` takes a `VideoGenerateRequest`
 *   (`src/contracts/diffusion.ts`) and answers `{jobId}`;
 * - `GET /atomic/v1/diffusion/video/jobs/:id` answers `{job: VideoJob | null}`;
 * - `POST /atomic/v1/diffusion/video/jobs/:id/cancel` answers `{cancelled, serverStopped}`.
 *
 * Only cloud clips for now: a request with `target` goes to the
 * provider's video adapter (`openrouter-videos` for OpenRouter), which
 * Core resolves from the key registered with `registerOpenRouterMedia`.
 * Core writes the clip under its own data folder and answers its path.
 *
 * OpenRouter documents no cancel for a video (`openrouter-videos.ts`):
 * cancelling here stops Core waiting, but the provider still finishes,
 * and bills, the clip it accepted.
 */

/** Used when Core's media catalog cannot be read; the catalog's own default (`catalog-baseline.json`). */
export const DEFAULT_OPENROUTER_VIDEO_MODEL = "google/veo-3.1-fast";

/**
 * Core's remote ceiling is 3 hours (`REMOTE_VIDEO_CEILING_MS`); a clip
 * on OpenRouter takes one to a few minutes, so the agent gives up far
 * sooner rather than holding the turn for hours.
 */
export const CORE_VIDEO_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 3_000;

export type CoreVideoWorkflow = "create" | "image-to-video";

/** Core's `VideoGenerateRequest`, the fields the agent sends. */
export interface CoreVideoRequest {
  prompt: string;
  negativePrompt?: string;
  /** Required by Core's parser even for a cloud model, which ignores them. */
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  /** Absent: Core draws one (when the model takes a seed). */
  seed?: number;
  workflow?: CoreVideoWorkflow;
  /** `image-to-video`: the first frame. Core reads the file itself. */
  initImage?: { path: string };
  /** `image-to-video`: the last frame, for models with `params.last_frame`. */
  endImage?: { path: string };
  target: { provider: string; model: string };
  /** Core's `RemoteVideoOptions`; each one only reaches a model whose catalog offers it. */
  remote?: { durationSecs?: number; resolution?: string; aspectRatio?: string; size?: string; generateAudio?: boolean };
}

export type CoreVideoJobState = "queued" | "generating" | "completed" | "failed" | "cancelled";

/** Core's `VideoJobProgress`. For a cloud clip `fraction` is time-based and `etaSeconds` is null. */
export interface CoreVideoProgress {
  phase?: string;
  step: number;
  totalSteps: number;
  fraction: number;
  etaSeconds: number | null;
  elapsedMs?: number;
}

/** The fields of Core's `GalleryVideoItem` the agent reads. */
export interface CoreVideoOutput {
  id: string;
  path: string;
  width: number;
  height: number;
  durationSecs: number;
  sizeBytes: number;
}

export interface CoreVideoJob {
  id: string;
  state: CoreVideoJobState;
  modelId?: string;
  progress?: CoreVideoProgress | null;
  outputs: CoreVideoOutput[];
  error?: { code: string; message: string; details?: string };
}

/** One entry of `GET /media/providers/:p/models?kind=video` (`VideoModelDescriptor`). */
export interface CoreVideoModel {
  id: string;
  name?: string;
  default?: boolean;
  workflows?: string[];
  params?: {
    durations?: { values?: number[]; min?: number; max?: number; default?: number };
    resolutions?: { values?: string[]; default?: string };
    aspect_ratios?: { values?: string[]; default?: string };
    audio?: boolean;
    seed?: boolean;
    last_frame?: boolean;
  };
}

/** A clip that failed, with Core's code when it gave one; `message` is a sentence a person can act on. */
export class CoreVideoError extends Error {
  override readonly name = "CoreVideoError";
  constructor(message: string, readonly code: string, options?: { cause?: unknown }) { super(message, options); }
}

const TERMINAL: ReadonlySet<CoreVideoJobState> = new Set(["completed", "failed", "cancelled"]);

/** Core's refusal codes in words a person can act on. Unknown codes keep Core's own message. */
export function describeCoreVideoError(code: string | undefined, message: string): string {
  const why = message.replace(/\.$/, "");
  switch (code) {
    case "JOB_BUSY":
      return "Atomic Core is already running 4 cloud generations. Wait for one to finish and try again.";
    case "QUEUE_FULL":
      return "Atomic Core's generation queue is full. Try again in a moment.";
    case "REMOTE_NOT_CONFIGURED":
      return "The cloud video provider is not set up in Atomic Core. Check that an OpenRouter key is configured.";
    case "REMOTE_AUTH_FAILED":
      return "OpenRouter refused the API key. Check the key in your provider settings.";
    case "REMOTE_QUOTA":
      return "OpenRouter says the account is out of credits. Top up at openrouter.ai and try again.";
    case "REMOTE_RATE_LIMITED":
      return "OpenRouter is rate limiting video requests. Try again in a minute.";
    case "REMOTE_CONTENT_BLOCKED":
      return `The video model refused this prompt (${why}). Rephrase it and try again.`;
    case "REMOTE_REJECTED":
    case "REMOTE_UNSUPPORTED":
    case "UNSUPPORTED_WORKFLOW":
      return `The video model rejected the request (${why}).`;
    case "REMOTE_TIMEOUT":
      return "The video model did not answer in time. Try again.";
    case "REMOTE_UNAVAILABLE":
      return `The cloud video provider is unavailable right now (${why}). Try again later.`;
    case "INVALID_REQUEST":
      return `Atomic Core rejected the video request (${why}).`;
    default:
      return `Video generation failed: ${why}.`;
  }
}

function toVideoError(err: unknown): unknown {
  if (err instanceof CoreRequestError) {
    return new CoreVideoError(describeCoreVideoError(err.code, err.message), err.code ?? "HTTP_ERROR", { cause: err });
  }
  return err;
}

/** Core's video models for a provider (catalog merged with the provider's live list). Empty when Core cannot say. */
export async function listCoreVideoModels(client: CoreControlClient, provider: string, signal?: AbortSignal): Promise<CoreVideoModel[]> {
  try {
    const answer = await client.call<{ models?: CoreVideoModel[] }>(`/media/providers/${encodeURIComponent(provider)}/models?kind=video`, undefined, { ...(signal ? { signal } : {}), timeoutMs: 20_000 });
    return Array.isArray(answer.models) ? answer.models.filter(m => typeof m?.id === "string" && m.id.length > 0) : [];
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

/** The catalog's default model, else its first, else the pinned fallback. */
export function defaultVideoModel(models: readonly CoreVideoModel[], fallback = DEFAULT_OPENROUTER_VIDEO_MODEL): string {
  return models.find(m => m.default)?.id ?? models[0]?.id ?? fallback;
}

export interface RunCoreVideoJobOptions {
  signal?: AbortSignal;
  onProgress?: (progress: CoreVideoProgress) => void;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Submit one clip and wait for it to settle. The submit is never
 * retried: the provider would bill twice. Abort (Esc) and the timeout
 * cancel the job in Core, which stops waiting; the provider may still
 * bill the clip. A completed job with no file is a failure.
 */
export async function runCoreVideoJob(client: CoreControlClient, request: CoreVideoRequest, opts: RunCoreVideoJobOptions = {}): Promise<CoreVideoJob> {
  const timeoutMs = opts.timeoutMs ?? CORE_VIDEO_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const sig = opts.signal ? { signal: opts.signal } : {};
  let jobId: string;
  try {
    const answer = await client.call<{ jobId?: unknown }>("/diffusion/video/jobs", request, { ...sig, timeoutMs: 60_000 });
    if (typeof answer.jobId !== "string" || answer.jobId.length === 0) throw new CoreVideoError("Atomic Core did not return a video job id.", "BAD_ANSWER");
    jobId = answer.jobId;
  } catch (err) { throw toVideoError(err); }

  const path = `/diffusion/video/jobs/${encodeURIComponent(jobId)}`;
  const cancel = () => client.call(`${path}/cancel`, {}, { timeoutMs: 5_000 }).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  let misses = 0;
  try {
    for (;;) {
      opts.signal?.throwIfAborted();
      if (Date.now() > deadline) {
        await cancel();
        throw new CoreVideoError(`The video was not ready after ${Math.round(timeoutMs / 60_000)} minutes, so Atomic Agent stopped waiting. OpenRouter may still finish and bill it.`, "TIMEOUT");
      }
      let job: CoreVideoJob | null;
      try {
        job = (await client.call<{ job: CoreVideoJob | null }>(path, undefined, { ...sig, timeoutMs: 15_000 })).job;
        misses = 0;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        // A dropped poll is not a failed job; give up only when Core stays unreachable.
        if (++misses >= 5) {
          await cancel();
          throw new CoreVideoError("Atomic Core stopped answering while the video was being made.", "CORE_UNREACHABLE", { cause: err });
        }
        await delay(pollMs, undefined, sig);
        continue;
      }
      if (!job) throw new CoreVideoError("Atomic Core lost track of the video job.", "JOB_NOT_FOUND");
      if (job.progress) opts.onProgress?.(job.progress);
      if (TERMINAL.has(job.state)) {
        if (job.state === "completed") {
          const outputs = (job.outputs ?? []).filter(o => typeof o?.path === "string" && o.path.length > 0);
          if (outputs.length === 0) throw new CoreVideoError("The video job finished without a clip.", "NO_OUTPUT");
          return { ...job, outputs };
        }
        if (job.state === "cancelled") throw new CoreVideoError("The video job was cancelled.", "CANCELLED");
        throw new CoreVideoError(describeCoreVideoError(job.error?.code, job.error?.message ?? "unknown error"), job.error?.code ?? "FAILED");
      }
      await delay(pollMs, undefined, sig);
    }
  } catch (err) {
    if (opts.signal?.aborted) await cancel();
    throw err;
  }
}
