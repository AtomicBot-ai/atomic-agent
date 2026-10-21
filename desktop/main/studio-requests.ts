/**
 * Studio: what the window asks for, turned into Core's generation requests,
 * and Core's jobs and gallery items turned into what the window draws.
 * Pure; no I/O.
 *
 * Core's shapes: atomic-chat-core v0.18.6 src/contracts/diffusion.ts
 * (`ImageGenerateRequest`, `VideoGenerateRequest`, `ImageJob`, `VideoJob`,
 * `GalleryImageItem`, `GalleryVideoItem`) and src/contracts/media.ts
 * (`MediaTarget`, `RemoteImageOptions`, `RemoteVideoOptions`). Core requires
 * width, height, steps and cfgScale on every request, also for a cloud
 * model, which ignores the ones its descriptor has no control for
 * (src/diffusion/remote-job.ts `imageGenerationJob`): 0 steps / 0 cfg is
 * "the model's default" there, as the agent's image tool sends
 * (src/tools/image/generate.ts).
 */

import type { StudioKind, StudioProvider } from "./studio-catalog.js";

export const IMAGE_MODES = ["create", "edit", "reference", "transform", "inpaint", "extend", "upscale"] as const;
export const VIDEO_MODES = ["create", "image-to-video"] as const;
export type StudioImageMode = (typeof IMAGE_MODES)[number];
export type StudioVideoMode = (typeof VIDEO_MODES)[number];

/** An input image: a file (picked, or a gallery item) or bytes the window holds. */
export type StudioSource = { path: string } | { base64: string };

export interface StudioImageRequest {
  provider: StudioProvider;
  model: string;
  mode?: StudioImageMode;
  prompt: string;
  negativePrompt?: string;
  count?: number;
  seed?: number;
  aspectRatio?: string;
  resolution?: string;
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  guidance?: number;
  strength?: number;
  samplingMethod?: string;
  initImage?: StudioSource;
  maskImage?: StudioSource;
  referenceImages?: StudioSource[];
}

export interface StudioVideoRequest {
  provider: StudioProvider;
  model: string;
  mode?: StudioVideoMode;
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  durationSecs?: number;
  resolution?: string;
  aspectRatio?: string;
  size?: string;
  audio?: boolean;
  firstFrame?: StudioSource;
  lastFrame?: StudioSource;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  steps?: number;
  cfgScale?: number;
  guidance?: number;
}

/** A request the window sent that cannot go to Core as it is. */
export class StudioRequestError extends Error {
  override readonly name = "StudioRequestError";
  readonly code = "INVALID_REQUEST";
}

const PROMPT_MAX = 8_000;
/** About one megapixel per ratio, multiples of 64 (the agent's image tool uses the same table). */
const RATIO_PIXELS: Readonly<Record<string, readonly [number, number]>> = {
  "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1152, 896], "3:4": [896, 1152],
  "3:2": [1216, 832], "2:3": [832, 1216], "21:9": [1536, 640], "9:21": [640, 1536], "4:5": [896, 1088], "5:4": [1088, 896],
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const optStr = (v: unknown, max = 64): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const optInt = (v: unknown, min: number, max: number): number | undefined => {
  const n = optNum(v);
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

function pick<T extends object>(target: T, key: keyof T, value: unknown): void {
  if (value !== undefined) (target as Record<string, unknown>)[key as string] = value;
}

/** A source as Core takes it; anything else is refused here, before Core reads a path. */
export function toCoreSource(v: unknown, what: string): { path: string } | { base64: string } {
  const o = obj(v);
  if (o && typeof o.path === "string" && o.path.length > 0 && !o.path.includes("\0")) return { path: o.path };
  if (o && typeof o.base64 === "string" && o.base64.length > 0) return { base64: o.base64 };
  throw new StudioRequestError(`${what} must be {path} or {base64}.`);
}

function common(raw: unknown, modes: readonly string[]): { r: Obj; provider: StudioProvider; model: string; mode: string; prompt: string } {
  const r = obj(raw);
  if (!r) throw new StudioRequestError("The request is empty.");
  const provider = r.provider === "local" ? "local" : r.provider === "openrouter" ? "openrouter" : null;
  if (!provider) throw new StudioRequestError("provider must be 'openrouter' or 'local'.");
  const model = optStr(r.model, 200);
  if (!model) throw new StudioRequestError("Pick a model first.");
  const mode = r.mode === undefined ? "create" : String(r.mode);
  if (!modes.includes(mode)) throw new StudioRequestError(`Unknown mode: ${mode}.`);
  const prompt = typeof r.prompt === "string" ? r.prompt.trim() : "";
  if (prompt.length > PROMPT_MAX) throw new StudioRequestError(`The prompt is longer than ${PROMPT_MAX} characters.`);
  return { r, provider, model, mode, prompt };
}

/** Defaults a local request falls back on: the loaded model's (`GET /diffusion/capabilities` `.defaults`). */
export interface LocalDefaults { width: number; height: number; steps: number; cfgScale: number }

/** The window's image request as Core's `ImageGenerateRequest`. */
export function toCoreImageRequest(raw: unknown, local?: LocalDefaults): Record<string, unknown> {
  const { r, provider, model, mode, prompt } = common(raw, IMAGE_MODES);
  if (!prompt && mode !== "upscale") throw new StudioRequestError("Write a prompt first.");
  if (mode !== "create" && r.initImage === undefined) throw new StudioRequestError("This mode needs a source image.");
  if ((mode === "inpaint" || mode === "extend") && r.maskImage === undefined) throw new StudioRequestError("This mode needs a mask.");
  const cloud = provider !== "local";
  const ratio = optStr(r.aspectRatio);
  const [rw, rh] = (ratio && RATIO_PIXELS[ratio]) || [1024, 1024];
  const width = optInt(r.width, 64, 8192) ?? (cloud ? rw : local?.width);
  const height = optInt(r.height, 64, 8192) ?? (cloud ? rh : local?.height);
  const steps = optInt(r.steps, 0, 500) ?? (cloud ? 0 : local?.steps);
  const cfgScale = optNum(r.cfgScale) ?? (cloud ? 0 : local?.cfgScale);
  if (width === undefined || height === undefined || steps === undefined || cfgScale === undefined) {
    throw new StudioRequestError("Load a local image model first.");
  }
  const out: Record<string, unknown> = {
    prompt, width, height, steps, cfgScale,
    batchSize: optInt(r.count, 1, 16) ?? 1,
    workflow: mode,
  };
  pick(out, "negativePrompt", optStr(r.negativePrompt, PROMPT_MAX));
  pick(out, "seed", optInt(r.seed, 0, 2 ** 32 - 1));
  pick(out, "guidance", optNum(r.guidance));
  pick(out, "strength", optNum(r.strength) !== undefined ? Math.min(1, Math.max(0, r.strength as number)) : undefined);
  pick(out, "samplingMethod", optStr(r.samplingMethod));
  if (mode !== "create") out.initImage = toCoreSource(r.initImage, "initImage");
  if (r.maskImage !== undefined) out.maskImage = toCoreSource(r.maskImage, "maskImage");
  if (Array.isArray(r.referenceImages) && r.referenceImages.length) {
    if (r.referenceImages.length > 16) throw new StudioRequestError("At most 16 reference images.");
    out.referenceImages = r.referenceImages.map((s, i) => toCoreSource(s, `referenceImages[${i}]`));
  }
  if (cloud) {
    out.target = { provider, model };
    const remote: Record<string, unknown> = {};
    pick(remote, "size", optStr(r.size));
    pick(remote, "aspectRatio", ratio);
    pick(remote, "resolution", optStr(r.resolution));
    pick(remote, "quality", optStr(r.quality));
    pick(remote, "background", optStr(r.background));
    pick(remote, "outputFormat", optStr(r.outputFormat));
    if (Object.keys(remote).length) out.remote = remote;
  }
  return out;
}

/** The window's video request as Core's `VideoGenerateRequest`. */
export function toCoreVideoRequest(raw: unknown, local?: LocalDefaults): Record<string, unknown> {
  const { r, provider, model, mode, prompt } = common(raw, VIDEO_MODES);
  const cloud = provider !== "local";
  if (mode === "image-to-video" && r.firstFrame === undefined) throw new StudioRequestError("Image to video needs a first frame.");
  if (!prompt && mode !== "image-to-video") throw new StudioRequestError("Write a prompt first.");
  if (!cloud && mode === "image-to-video") throw new StudioRequestError("Image to video works with cloud models only for now.");
  const width = optInt(r.width, 64, 8192) ?? (cloud ? 1280 : local?.width);
  const height = optInt(r.height, 64, 8192) ?? (cloud ? 720 : local?.height);
  const steps = optInt(r.steps, 0, 500) ?? (cloud ? 0 : local?.steps);
  const cfgScale = optNum(r.cfgScale) ?? (cloud ? 0 : local?.cfgScale);
  if (width === undefined || height === undefined || steps === undefined || cfgScale === undefined) {
    throw new StudioRequestError("Load a local video model first.");
  }
  const out: Record<string, unknown> = { prompt, width, height, steps, cfgScale, workflow: mode };
  pick(out, "negativePrompt", optStr(r.negativePrompt, PROMPT_MAX));
  pick(out, "seed", optInt(r.seed, 0, 2 ** 32 - 1));
  pick(out, "guidance", optNum(r.guidance));
  if (!cloud) {
    pick(out, "frames", optInt(r.frames, 1, 10_000));
    pick(out, "fps", optInt(r.fps, 1, 240));
  }
  if (r.firstFrame !== undefined) out.initImage = toCoreSource(r.firstFrame, "firstFrame");
  if (r.lastFrame !== undefined) out.endImage = toCoreSource(r.lastFrame, "lastFrame");
  if (cloud) {
    out.target = { provider, model };
    const remote: Record<string, unknown> = {};
    pick(remote, "durationSecs", optNum(r.durationSecs));
    pick(remote, "resolution", optStr(r.resolution));
    pick(remote, "aspectRatio", optStr(r.aspectRatio));
    pick(remote, "size", optStr(r.size));
    pick(remote, "generateAudio", typeof r.audio === "boolean" ? r.audio : undefined);
    if (Object.keys(remote).length) out.remote = remote;
  }
  return out;
}

/* ---------------------------------------------------------------- results */

export interface StudioItem {
  id: string;
  kind: StudioKind;
  path: string;
  /** Image: the 256 px thumbnail. Video: the poster, once one exists. Null otherwise. */
  thumbnailPath: string | null;
  width: number;
  height: number;
  sizeBytes: number;
  createdAtMs: number;
  pinned: boolean;
  archived: boolean;
  /** Video only. */
  durationSecs: number | null;
  prompt: string;
  model: { id: string; name: string; provider: string };
  /** Core's recipe, verbatim (enough to restore the form). */
  recipe: unknown;
}

export interface StudioJob {
  id: string;
  kind: StudioKind;
  state: "queued" | "generating" | "completed" | "failed" | "cancelled";
  cloud: boolean;
  model: string;
  progress: {
    phase: string;
    step: number;
    totalSteps: number;
    fraction: number;
    etaSeconds: number | null;
    batchIndex: number | null;
    batchSize: number | null;
    slowdown: boolean;
  } | null;
  outputs: StudioItem[];
  error: { code: string; message: string; details?: string } | null;
  createdAtMs: number;
  finishedAtMs: number | null;
}

const n0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function normalizeItem(raw: unknown, kind: StudioKind): StudioItem | null {
  const i = obj(raw);
  if (!i || typeof i.id !== "string" || typeof i.path !== "string") return null;
  const recipe = obj(i.recipe) ?? {};
  const model = obj(recipe.model) ?? {};
  const engine = obj(recipe.engine) ?? {};
  const remote = engine.kind === "remote";
  return {
    id: i.id,
    kind,
    path: i.path,
    thumbnailPath: typeof (kind === "image" ? i.thumbnailPath : i.posterPath) === "string" ? ((kind === "image" ? i.thumbnailPath : i.posterPath) as string) : null,
    width: n0(i.width),
    height: n0(i.height),
    sizeBytes: n0(i.sizeBytes),
    createdAtMs: n0(i.createdAtMs),
    pinned: i.pinned === true,
    archived: i.archived === true,
    durationSecs: kind === "video" ? n0(i.durationSecs) || n0(recipe.durationSecs) || null : null,
    prompt: typeof recipe.prompt === "string" ? recipe.prompt : "",
    model: {
      id: typeof model.modelId === "string" ? model.modelId : "",
      name: typeof model.displayName === "string" ? model.displayName : "",
      provider: remote && typeof engine.provider === "string" ? engine.provider : "local",
    },
    recipe: i.recipe ?? null,
  };
}

const STATES = new Set(["queued", "generating", "completed", "failed", "cancelled"]);

export function normalizeJob(raw: unknown, kind: StudioKind): StudioJob | null {
  const j = obj(raw);
  if (!j || typeof j.id !== "string" || !STATES.has(String(j.state))) return null;
  const p = obj(j.progress);
  const e = obj(j.error);
  return {
    id: j.id,
    kind,
    state: j.state as StudioJob["state"],
    cloud: obj(obj(j.request)?.target) !== null,
    model: typeof j.modelId === "string" ? j.modelId : "",
    progress: p ? {
      phase: typeof p.phase === "string" ? p.phase : "queued",
      step: n0(p.step),
      totalSteps: n0(p.totalSteps),
      fraction: Math.min(1, Math.max(0, n0(p.fraction))),
      etaSeconds: typeof p.etaSeconds === "number" ? p.etaSeconds : null,
      batchIndex: typeof p.batchIndex === "number" ? p.batchIndex : null,
      batchSize: typeof p.batchSize === "number" ? p.batchSize : null,
      slowdown: p.slowdown === true,
    } : null,
    outputs: (Array.isArray(j.outputs) ? j.outputs : []).map((o) => normalizeItem(o, kind)).filter((o): o is StudioItem => o !== null),
    error: e ? { code: String(e.code ?? "INTERNAL"), message: String(e.message ?? ""), ...(typeof e.details === "string" ? { details: e.details } : {}) } : null,
    createdAtMs: n0(j.createdAtMs),
    finishedAtMs: typeof j.finishedAtMs === "number" ? j.finishedAtMs : null,
  };
}

/** A progress event (`diffusion:progress`, `diffusion:video-progress`) applied to the last job seen. */
export function withProgress(job: StudioJob, progress: unknown): StudioJob {
  const merged = normalizeJob({ id: job.id, state: job.state === "queued" ? "generating" : job.state, progress }, job.kind);
  return merged ? { ...job, state: merged.state, progress: merged.progress } : job;
}
