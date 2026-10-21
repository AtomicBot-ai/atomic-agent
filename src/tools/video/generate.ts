import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { VideoGeneratedContext } from "../../analytics/analytics-events.js";
import { imageCoreNeedsInstall, registerOpenRouterMedia, withImageCore } from "../../local-llm/core/core-image.js";
import {
  CoreVideoError,
  defaultVideoModel,
  DEFAULT_OPENROUTER_VIDEO_MODEL,
  listCoreVideoModels,
  runCoreVideoJob,
  type CoreVideoModel,
  type CoreVideoOutput,
  type CoreVideoProgress,
} from "../../local-llm/core/core-video.js";
import { loadImageFile } from "../vision/load-image.js";
import type { ToolDefinition } from "../tool-registry.js";
import { parseVideoArgs, type VideoArgs } from "./args.js";
import { fitVideoToModel, nominalSize } from "./fit-model.js";

export const VIDEO_GENERATE_TOOL = "video.generate";
/** OpenRouter takes the first frame as a data URL; a bigger picture only slows the upload. */
const FIRST_FRAME_MAX_BYTES = 20 * 1024 * 1024;
/** A cloud model's progress is a time-based guess; one line this often is enough. */
const PROGRESS_EVERY_MS = 20_000;

const NO_LOCAL = "Local video models are not available in Atomic Agent yet. Without `model`, the clip is made in the cloud with the OpenRouter key.";
const NO_KEY = "Video generation needs an OpenRouter API key. Add one in the provider settings and try again.";

/** One progress line for the running tool card. */
export interface VideoProgressUpdate { fraction: number; elapsedMs: number; label: string }

export interface VideoGenerateToolOptions extends DangerousToolOptions {
  /** `config.paths.localModelsDataDir`, read per call. */
  dataDir: () => string;
  /** The user's OpenRouter key, read per call; undefined when none is set. */
  openRouterKey: () => string | undefined;
  /** Whether the first clip downloads the Core binary; default reads the data folder. */
  needsCoreInstall?: (dataDir: string) => boolean;
  /** One shape-only analytics record per call that got past approval (`captureVideoGenerated`). */
  report?: (event: VideoGeneratedContext) => void;
  /** Progress for the running tool card, throttled here; the runtime turns it into a `tool_progress` event. */
  onProgress?: (sessionId: string, update: VideoProgressUpdate) => void;
  /** Test seams. */
  withCore?: typeof withImageCore;
  now?: () => Date;
  progressEveryMs?: number;
}

/** `video-20261021-142233.mp4`, then `-2`, `-3`, ...; never an existing file. */
async function saveIntoWorkingDir(output: CoreVideoOutput, workingDir: string, now: Date): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = /^\.(mp4|webm|mov)$/i.test(extname(output.path)) ? extname(output.path).toLowerCase() : ".mp4";
  for (let n = 1; ; n++) {
    const dest = join(workingDir, n === 1 ? `video-${stamp}${ext}` : `video-${stamp}-${n}${ext}`);
    try {
      await copyFile(output.path, dest, fsConstants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n >= 50) throw err;
    }
  }
}

function minutes(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * A refusal for capacity at the provider (429, 502/503, "busy",
 * "overloaded"): nothing was billed, and another model or a minute later
 * may work.
 */
export function isProviderBusy(err: unknown): boolean {
  if (!(err instanceof CoreVideoError)) return false;
  if (err.code === "REMOTE_RATE_LIMITED" || err.code === "REMOTE_UNAVAILABLE") return true;
  return err.code.startsWith("REMOTE_") && /\b(busy|overloaded|capacity|try again later)\b/i.test(err.message);
}

/**
 * "Veo 3.1 Fast is busy ..." with up to three catalog models that can
 * take the same clip. Core's catalog carries no prices, so none are
 * quoted; the agent must ask the user before passing another `model`.
 */
export function busyMessage(modelId: string, models: readonly CoreVideoModel[], args: VideoArgs): string {
  const busy = models.find(m => m.id === modelId)?.name ?? modelId;
  const alternatives = models
    .filter(m => m.id !== modelId && fitVideoToModel(args, m).ok)
    .slice(0, 3)
    .map(m => (m.name ? `${m.name} (${m.id})` : m.id));
  return `${busy} is busy at OpenRouter right now (nothing was billed). Try again in a minute` +
    (alternatives.length > 0 ? `, or use another model: ${alternatives.join(", ")}.` : ".") +
    " Ask the user which they want before calling video.generate again; pass another model only if the user names it (prices differ by model).";
}

/** The approval sentence: what is made, where, who pays, and that stopping does not refund. */
export function videoApprovalReason(args: VideoArgs, installFirst: boolean): string {
  const model = args.model ?? `${DEFAULT_OPENROUTER_VIDEO_MODEL} (the default)`;
  const source = args.image !== undefined ? ` from ${args.image}` : "";
  return `generate a paid ${args.duration}-second video${source} on OpenRouter with ${model}, billed to the OpenRouter account, and save it in the working folder. ` +
    "Stopping the agent does not cancel the charge: once OpenRouter accepts the clip, it bills it" +
    (installFirst ? "; first downloads the Atomic Chat engine (about 100 MB)" : "");
}

/**
 * `video.generate { prompt, image?, duration?, aspect?, resolution?, audio?, seed?, model? }`
 * — make a short clip through Atomic Chat Core's video jobs
 * (`src/local-llm/core/core-video.ts`) on OpenRouter with the user's key,
 * and save it in the session's working folder. The agent shows it by
 * passing the path to `reply { attachments }`.
 *
 * Always paid, so it asks below approval level 3 (`paid_generation`),
 * and the question says that stopping does not refund: OpenRouter has no
 * cancel for a video, and the owner decided the agent does not promise
 * one. `image` (a first frame) is read-scoped like any read
 * (`READ_TOOL_TARGETS`) and checked to be a real picture before asking.
 */
export function buildVideoGenerateTool(options: VideoGenerateToolOptions): ToolDefinition {
  const withCore = options.withCore ?? withImageCore;
  const now = options.now ?? (() => new Date());
  const every = options.progressEveryMs ?? PROGRESS_EVERY_MS;
  return {
    name: VIDEO_GENERATE_TOOL,
    description: "Generate a short video clip from a text prompt (optionally starting from an image) and save it as a video file in the working folder. Show it to the user by passing the returned path to reply.attachments. A busy model is never swapped silently: ask the user before passing another model.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: VideoArgs;
      try { args = parseVideoArgs(rawArgs); }
      catch (err) { return errorResult((err as Error).message); }
      if (args.local) return errorResult(NO_LOCAL);
      const key = options.openRouterKey();
      if (key === undefined) return errorResult(NO_KEY);
      const apiKey: string = key;

      let firstFrame: string | undefined;
      if (args.image !== undefined) {
        try { firstFrame = (await loadImageFile(args.image, ctx.workingDir, { maxBytes: FIRST_FRAME_MAX_BYTES })).path; }
        catch (err) { return errorResult(`\`image\` cannot be used as the first frame: ${(err as Error).message}`); }
      }

      const dataDir = options.dataDir();
      const installFirst = (options.needsCoreInstall ?? imageCoreNeedsInstall)(dataDir);
      await requireApproval(options, {
        sessionId: ctx.sessionId,
        tool: VIDEO_GENERATE_TOOL,
        category: "paid_generation",
        reason: videoApprovalReason(args, installFirst),
        preview: args.prompt,
        affectedResources: ["openrouter.ai"],
      }, ctx.signal);

      const started = Date.now();
      let modelId = args.model ?? "default";
      let reportedModel = args.model ? "custom" : "default";
      let duration = args.duration;
      const report = (outcome: VideoGeneratedContext["outcome"], errorCode?: string) => options.report?.({
        model: reportedModel, durationSecs: duration, outcome, ...(errorCode !== undefined ? { errorCode } : {}),
      });
      let lastProgress = -Infinity;
      const onProgress = (p: CoreVideoProgress) => {
        const at = Date.now();
        if (!options.onProgress || at - lastProgress < every) return;
        lastProgress = at;
        const elapsed = p.elapsedMs ?? at - started;
        const pct = Math.round(Math.min(Math.max(p.fraction, 0), 0.99) * 100);
        options.onProgress(ctx.sessionId, { fraction: p.fraction, elapsedMs: elapsed, label: `making the video with ${modelId} · about ${pct}% · ${minutes(elapsed)} elapsed` });
      };

      let made: CoreVideoOutput | undefined;
      try {
        const result = await withCore(dataDir, async (client) => {
          await registerOpenRouterMedia(client, apiKey, ctx.signal);
          const models = await listCoreVideoModels(client, "openrouter", ctx.signal);
          const runOn = async (model: string) => {
            const fitted = fitVideoToModel(args, models.find(m => m.id === model));
            if (!fitted.ok) throw new CoreVideoError(fitted.reason, "UNSUPPORTED_BY_MODEL");
            duration = fitted.duration;
            // Analytics names a model only when Core's catalog lists it; an
            // id the user typed is `custom`.
            reportedModel = !args.model || models.some(m => m.id === model) ? model : "custom";
            options.onProgress?.(ctx.sessionId, { fraction: 0, elapsedMs: Date.now() - started, label: `sent to ${model} on OpenRouter` });
            lastProgress = Date.now();
            const job = await runCoreVideoJob(client, {
              prompt: args.prompt, ...nominalSize(fitted.remote.aspectRatio), steps: 0, cfgScale: 0,
              ...(args.seed !== undefined ? { seed: args.seed } : {}),
              workflow: fitted.workflow,
              ...(firstFrame !== undefined ? { initImage: { path: firstFrame } } : {}),
              target: { provider: "openrouter", model },
              remote: fitted.remote,
            }, { signal: ctx.signal, onProgress });
            return { job, notes: fitted.notes };
          };

          modelId = args.model ?? defaultVideoModel(models);
          try {
            const attempt = await runOn(modelId);
            return { output: attempt.job.outputs[0]!, notes: attempt.notes };
          } catch (err) {
            // Owner decision: never switch models on our own. Another model
            // costs differently, so a busy one ends the call with the
            // alternatives and the agent asks the user which to use.
            if (ctx.signal.aborted || !isProviderBusy(err)) throw err;
            throw new CoreVideoError(busyMessage(modelId, models, args), (err as CoreVideoError).code);
          }
        }, { signal: ctx.signal });

        made = result.output;
        const path = await saveIntoWorkingDir(made, ctx.workingDir, now());
        report("success");
        const lines = [
          `Saved a ${made.durationSecs > 0 ? `${Math.round(made.durationSecs)}-second ` : ""}video made with ${modelId} on OpenRouter:`,
          `- ${path}`,
          ...result.notes,
          "To show it to the user, pass this path in reply.attachments.",
        ];
        return compressToolResult({
          tool: VIDEO_GENERATE_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            paths: [path], kind: "cloud", model: modelId, durationMs: Date.now() - started,
            video: { width: made.width, height: made.height, durationSecs: made.durationSecs, bytes: made.sizeBytes },
          },
        }, { maxSummaryLength: 2_000, maxTailLines: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        if (ctx.signal.aborted) { report("cancelled"); throw err; }
        const code = err instanceof CoreVideoError ? err.code : (err as { reasonCode?: unknown })?.reasonCode;
        report("failed", typeof code === "string" ? code : "unknown");
        const message = err instanceof Error ? err.message : String(err);
        // A clip already paid for must not vanish with a failed copy.
        return errorResult(made ? `${message}\nThe video was made and is kept at:\n- ${made.path}` : message, {
          kind: "cloud", model: modelId,
          ...(made ? { corePaths: [made.path] } : {}),
          ...(err instanceof CoreVideoError ? { code: err.code } : {}),
        });
      }
    },
  };
}

function errorResult(message: string, details?: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({
    tool: VIDEO_GENERATE_TOOL,
    status: "error",
    output: `video.generate: ${message}`,
    ...(details ? { details } : {}),
  });
}
