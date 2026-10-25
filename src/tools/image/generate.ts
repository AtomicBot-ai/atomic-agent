import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ImageGeneratedContext } from "../../analytics/analytics-events.js";
import {
  CoreImageError,
  defaultImageModel,
  imageCoreNeedsInstall,
  listCoreImageModels,
  registerOpenRouterMedia,
  runCoreImageJob,
  withImageCore,
  type CoreImageJob,
  type CoreImageOutput,
  type CoreImageRequest,
  type CoreMediaModel,
} from "../../local-llm/core/core-image.js";
import type { ToolDefinition } from "../tool-registry.js";

export const IMAGE_GENERATE_TOOL = "image.generate";
export const IMAGE_COUNT_MAX = 4;
const PROMPT_MAX_CHARS = 4_000;

/**
 * Aspect ratios the tool takes, with the pixel size for each (about one
 * megapixel, multiples of 64). Core requires width and height; a cloud
 * model gets the ratio itself and its catalog decides the pixels.
 */
const RATIOS: Readonly<Record<string, readonly [number, number]>> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};
const SIZE_WORDS: Readonly<Record<string, string>> = {
  square: "1:1", landscape: "16:9", wide: "16:9", portrait: "9:16", tall: "9:16",
};

/**
 * Core requires `steps` and `cfgScale` on every job and forwards them to
 * a cloud model whose catalog entry takes them; 0 is "the model's
 * default" there.
 */
const CLOUD_STEPS = 0;
const CLOUD_CFG_SCALE = 0;

/** Until local image models can be installed (ATO-411), `model: "local"` gets this. */
const NO_LOCAL_YET = "Local image models are not available in Atomic Agent yet; they come in a later update. Without `model`, the picture is made in the cloud with the OpenRouter key.";
const NO_KEY = "Image generation needs an OpenRouter API key for now (local image models come in a later update). Add one in the provider settings and try again.";

export interface ImageGenerateToolOptions extends DangerousToolOptions {
  /** `config.paths.localModelsDataDir`, read per call. */
  dataDir: () => string;
  /** The user's OpenRouter key, read per call; undefined when none is set. */
  openRouterKey: () => string | undefined;
  /** Whether the first picture downloads the Core binary; default reads the data folder. */
  needsCoreInstall?: (dataDir: string) => boolean;
  /** One shape-only analytics record per call (`captureImageGenerated`). */
  report?: (event: ImageGeneratedContext) => void;
  /** Test seam. */
  withCore?: typeof withImageCore;
  now?: () => Date;
}

interface ParsedArgs {
  prompt: string;
  ratio: string;
  count: number;
  seed?: number;
  model?: string;
  local: boolean;
}

/** A cloud model's catalog says how many pictures one request may draw. */
function nMaxOf(model: CoreMediaModel | undefined): number {
  const n = model?.params?.n?.max;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseArgs(raw: Record<string, unknown>): ParsedArgs {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("`prompt` must be a non-empty string describing the picture");
  if (prompt.length > PROMPT_MAX_CHARS) throw new Error(`\`prompt\` is longer than ${PROMPT_MAX_CHARS} characters; shorten it`);

  let ratio = "1:1";
  if (raw.size !== undefined && raw.size !== null && raw.size !== "") {
    if (typeof raw.size !== "string") throw new Error("`size` must be a string such as \"square\", \"landscape\", \"portrait\" or \"16:9\"");
    const word = raw.size.trim().toLowerCase();
    ratio = SIZE_WORDS[word] ?? word;
    if (!(ratio in RATIOS)) {
      throw new Error(`\`size\` "${raw.size}" is not supported; use square, landscape, portrait or one of ${Object.keys(RATIOS).join(", ")}`);
    }
  }

  let count = 1;
  if (raw.count !== undefined && raw.count !== null) {
    if (typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > IMAGE_COUNT_MAX) {
      throw new Error(`\`count\` must be a whole number from 1 to ${IMAGE_COUNT_MAX}`);
    }
    count = raw.count;
  }

  let seed: number | undefined;
  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== "number" || !Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffff_ffff) {
      throw new Error("`seed` must be a whole number from 0 to 4294967295");
    }
    seed = raw.seed;
  }

  let model: string | undefined;
  let local = false;
  if (typeof raw.model === "string" && raw.model.trim().length > 0) {
    const name = raw.model.trim();
    if (name.toLowerCase() === "local") local = true;
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)) throw new Error(`\`model\` "${name}" is not a model id such as google/gemini-nano-banana-2.1`);
    else model = name;
  } else if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
    throw new Error("`model` must be a string");
  }

  return { prompt, ratio, count, ...(seed !== undefined ? { seed } : {}), ...(model ? { model } : {}), local };
}

/** `image-20261015-142233.png`, `image-20261015-142233-2.png`, never an existing file. */
async function saveIntoWorkingDir(outputs: readonly CoreImageOutput[], workingDir: string, now: Date): Promise<string[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const saved: string[] = [];
  let n = 0;
  for (const output of outputs) {
    const ext = /^\.(png|jpe?g|webp)$/i.test(extname(output.path)) ? extname(output.path).toLowerCase() : ".png";
    for (let attempt = 0; ; attempt++) {
      n += 1;
      const name = n === 1 && attempt === 0 ? `image-${stamp}${ext}` : `image-${stamp}-${n}${ext}`;
      const dest = join(workingDir, name);
      try {
        await copyFile(output.path, dest, fsConstants.COPYFILE_EXCL);
        saved.push(dest);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 50) throw err;
      }
    }
  }
  return saved;
}

/**
 * Jobs for `count` pictures on a cloud model: as few as the model's
 * per-request limit (`params.n.max`, default 1) allows. Core runs up to
 * 4 cloud jobs at a time.
 */
export function cloudBatches(count: number, model: CoreMediaModel | undefined): number[] {
  const nMax = nMaxOf(model);
  const batches: number[] = [];
  for (let left = count; left > 0; left -= nMax) batches.push(Math.min(nMax, left));
  return batches;
}

/** The ratio when the model takes it; undefined (the model's default) when its catalog lists others only. */
export function cloudAspectRatio(ratio: string, model: CoreMediaModel | undefined): string | undefined {
  const values = model?.params?.aspect_ratios?.values;
  if (!values || values.length === 0) return ratio;
  return values.includes(ratio) ? ratio : undefined;
}

function plural(count: number): string { return count === 1 ? "1 image" : `${count} images`; }

/**
 * `image.generate { prompt, size?, count?, seed?, model? }` — draw
 * pictures through Atomic Chat Core and save them as files in the
 * session's working folder. The agent shows them by passing the paths
 * to `reply { attachments }`.
 *
 * The picture is made in the cloud with the user's OpenRouter key (paid,
 * so it asks for approval below approval level 3). Local image models
 * come with ATO-411; until then `model: "local"` and a missing key get a
 * plain answer without touching Core. The first image on a computer
 * without Core downloads the Core binary once, which the approval says.
 */
export function buildImageGenerateTool(options: ImageGenerateToolOptions): ToolDefinition {
  const withCore = options.withCore ?? withImageCore;
  const now = options.now ?? (() => new Date());
  return {
    name: IMAGE_GENERATE_TOOL,
    description: "Generate pictures from a text prompt and save them as image files in the working folder. Show them to the user by passing the returned paths to reply.attachments.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: ParsedArgs;
      try { args = parseArgs(rawArgs); }
      catch (err) { return errorResult((err as Error).message); }

      if (args.local) return errorResult(NO_LOCAL_YET);
      const key = options.openRouterKey();
      if (key === undefined) return errorResult(NO_KEY);
      const apiKey: string = key;

      const dataDir = options.dataDir();
      const installFirst = (options.needsCoreInstall ?? imageCoreNeedsInstall)(dataDir);
      await requireApproval(options, {
        sessionId: ctx.sessionId,
        tool: IMAGE_GENERATE_TOOL,
        category: "paid_generation",
        reason: `generate ${plural(args.count)} on OpenRouter with ${args.model ?? "the default image model"} (paid by the OpenRouter account) and save ${args.count === 1 ? "it" : "them"} in the working folder` +
          (installFirst ? "; first downloads the Atomic Chat engine (about 100 MB)" : ""),
        preview: args.prompt,
        affectedResources: ["openrouter.ai"],
      }, ctx.signal);

      const started = Date.now();
      // Analytics names a model only when Core's catalog lists it; a model
      // id the user typed is reported as `custom`.
      let modelId = args.model ?? "default";
      let reportedModel = args.model ? "custom" : "default";
      const report = (success: boolean, count: number, errorCode?: string) => options.report?.({
        kind: "cloud", model: reportedModel, durationMs: Date.now() - started, success, count,
        ...(errorCode !== undefined ? { errorCode } : {}),
      });

      let outputs: CoreImageOutput[] = [];
      try {
        const result = await withCore(dataDir, async (client) => {
          const [width, height] = RATIOS[args.ratio]!;
          await registerOpenRouterMedia(client, apiKey, ctx.signal);
          const models = await listCoreImageModels(client, "openrouter", ctx.signal);
          const notes: string[] = [];
          const runOn = async (model: string) => {
            const info = models.find(m => m.id === model);
            const aspectRatio = cloudAspectRatio(args.ratio, info);
            const request: CoreImageRequest = {
              prompt: args.prompt, width, height, steps: CLOUD_STEPS, cfgScale: CLOUD_CFG_SCALE, batchSize: 1,
              target: { provider: "openrouter", model },
              ...(aspectRatio ? { remote: { aspectRatio } } : {}),
            };
            // Core varies the seed only inside one job: separate jobs get
            // seed, seed+1, ... or every picture would be the same.
            let seedOffset = 0;
            const jobs = cloudBatches(args.count, info).map(batchSize => {
              const seed = args.seed === undefined ? undefined : (args.seed + seedOffset) % 0x1_0000_0000;
              seedOffset += batchSize;
              return { ...request, batchSize, ...(seed !== undefined ? { seed } : {}) };
            });
            const settled = await Promise.allSettled(jobs.map(job => runCoreImageJob(client, job, { signal: ctx.signal })));
            return {
              info, aspectRatio, total: settled.length,
              done: settled.flatMap(r => r.status === "fulfilled" ? [r.value] : []),
              failed: settled.flatMap(r => r.status === "rejected" ? [r.reason as unknown] : []),
            };
          };

          modelId = args.model ?? defaultImageModel(models);
          let attempt = await runOn(modelId);
          // The default model is Core's pick, not the user's: when its
          // upstream refuses for capacity (a 429 or 502 bills nothing), the
          // next catalog model gets one try.
          const fallback = models.find(m => m.id !== modelId)?.id;
          if (!args.model && attempt.done.length === 0 && fallback && !ctx.signal.aborted &&
              attempt.failed.every(e => e instanceof CoreImageError && (e.code === "REMOTE_RATE_LIMITED" || e.code === "REMOTE_UNAVAILABLE"))) {
            notes.push(`${modelId} was busy at OpenRouter (${(attempt.failed[0] as Error).message}), so ${fallback} made it instead.`);
            modelId = fallback;
            attempt = await runOn(modelId);
          }
          if (attempt.info || !args.model) reportedModel = modelId;
          if (attempt.aspectRatio === undefined) notes.push(`${modelId} does not offer ${args.ratio}, so it used its default shape.`);
          const done = attempt.done;
          const failed = attempt.failed;
          if (done.length === 0) throw failed[0];
          if (failed.length > 0) notes.push(`${failed.length} of the ${attempt.total} requests failed: ${(failed[0] as Error).message}`);
          return { jobs: done, notes };
        }, { signal: ctx.signal });

        outputs = result.jobs.flatMap((job: CoreImageJob) => job.outputs);
        const paths = await saveIntoWorkingDir(outputs, ctx.workingDir, now());
        report(true, paths.length);
        const lines = [
          `Saved ${plural(paths.length)} made with ${modelId} on OpenRouter:`,
          ...paths.map(p => `- ${p}`),
          ...result.notes,
          `To show ${paths.length === 1 ? "it" : "them"} to the user, pass ${paths.length === 1 ? "this path" : "these paths"} in reply.attachments.`,
        ];
        return compressToolResult({
          tool: IMAGE_GENERATE_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            paths,
            kind: "cloud",
            model: modelId,
            durationMs: Date.now() - started,
            images: outputs.map(o => ({ width: o.width, height: o.height, bytes: o.sizeBytes })),
          },
        }, { maxSummaryLength: 2_000, maxTailLines: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        if (ctx.signal.aborted) { report(false, 0, "cancelled"); throw err; }
        const code = err instanceof CoreImageError ? err.code : (err as { reasonCode?: unknown })?.reasonCode;
        report(false, 0, typeof code === "string" ? code : "unknown");
        const message = err instanceof Error ? err.message : String(err);
        // Pictures already paid for must not vanish with a failed copy.
        const made = outputs.map(o => o.path);
        return errorResult(made.length > 0 ? `${message}\nThe pictures were made and are kept at:\n${made.map(p => `- ${p}`).join("\n")}` : message, {
          kind: "cloud", model: modelId,
          ...(made.length > 0 ? { corePaths: made } : {}),
          ...(err instanceof CoreImageError ? { code: err.code } : {}),
        });
      }
    },
  };
}

function errorResult(message: string, details?: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({
    tool: IMAGE_GENERATE_TOOL,
    status: "error",
    output: `image.generate: ${message}`,
    ...(details ? { details } : {}),
  });
}
