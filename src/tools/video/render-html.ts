import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright-core";

import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { getConfig, type AtomicAgentConfig } from "../../config/index.js";
import { categorizeFsMutation } from "../os/fs/fs-approval-scope.js";
import type { ToolDefinition } from "../tool-registry.js";
import { defaultBrowserLauncher } from "../verify/run-page-kind.js";
import { parseRenderHtmlArgs, type RenderHtmlArgs } from "./render-html-args.js";
import { FfmpegMissingError, probeFfmpeg, startFfmpegEncoder, type SpawnFn } from "./render-html-ffmpeg.js";
import { captureFrames, type CaptureFramesInput, type RenderSource } from "./render-html-frames.js";

export const VIDEO_RENDER_HTML_TOOL = "video.render_html";
const PROGRESS_EVERY_MS = 2_000;

const NO_BROWSER_HINT =
  "Install Google Chrome (or Chromium, Edge or Brave), or set `browser.executablePath` in the config, then call video.render_html again.";

/** One progress line for the running tool card. */
export interface RenderHtmlProgress { fraction: number; elapsedMs: number; label: string }

export interface RenderHtmlToolOptions extends DangerousToolOptions {
  /** Browser settings (`channel`, `executablePath`, `noSandbox`), read per call. Default: the live config. */
  browserConfig?: () => Pick<AtomicAgentConfig, "browser">;
  /** The agent's own config files; a write onto one asks as `trust_config`. */
  trustConfigPaths?: () => readonly string[];
  /** The ffmpeg binary; default `ffmpeg` on PATH, as the ffmpeg starter skill uses it. */
  ffmpegPath?: () => string;
  onProgress?: (sessionId: string, update: RenderHtmlProgress) => void;
  /** Test seams. */
  spawn?: SpawnFn;
  launchBrowser?: () => Promise<Browser>;
  capture?: (input: CaptureFramesInput) => Promise<{ pageErrors: string[] }>;
  now?: () => Date;
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Where the clip goes: the named file inside the working folder, or a
 * fresh `video-html-<timestamp>.mp4`. Never an existing file, never
 * outside the working folder. Throws the sentence the agent sees.
 */
export function resolveRenderOutput(args: Pick<RenderHtmlArgs, "output">, workingDir: string, now: Date): string {
  if (args.output !== undefined) {
    const out = resolve(workingDir, args.output);
    if (!inside(resolve(workingDir), out)) throw new Error("`output` must be a file inside the working folder");
    if (existsSync(out)) throw new Error(`${args.output} already exists; pass another \`output\` name (an existing file is never overwritten)`);
    return out;
  }
  const base = `video-html-${stamp(now)}`;
  for (let n = 1; n <= 50; n++) {
    const out = join(workingDir, n === 1 ? `${base}.mp4` : `${base}-${n}.mp4`);
    if (!existsSync(out)) return out;
  }
  throw new Error("could not find a free file name for the video; pass `output`");
}

/** The page to load, checked to be a file. Throws the sentence the agent sees. */
export function resolveRenderSource(args: Pick<RenderHtmlArgs, "path" | "html">, workingDir: string): RenderSource {
  if (args.html !== undefined) return { kind: "html", html: args.html };
  const file = resolve(workingDir, args.path ?? "");
  let isFile = false;
  try { isFile = statSync(file).isFile(); } catch { /* missing */ }
  if (!isFile) throw new Error(`no such file: ${args.path}`);
  return { kind: "file", url: pathToFileURL(file).href };
}

/** The approval sentence: what is rendered, how long, where it is saved. */
export function renderHtmlApprovalReason(args: RenderHtmlArgs, outputPath: string): string {
  const what = args.path !== undefined ? args.path : "the given HTML";
  return `render ${what} in a headless browser to a ${args.duration}-second ${args.width}×${args.height} video at ${args.fps} fps and save it as ${outputPath}`;
}

/**
 * `video.render_html { path | html, duration?, fps?, width?, height?, output? }`
 * — record an HTML page (an animation, a title card, a chart) to an
 * `.mp4` in the working folder, frame by frame on a virtual clock
 * (`render-html-frames.ts`), assembled by the local `ffmpeg`
 * (`render-html-ffmpeg.ts`). Free and local: no model, no credits.
 *
 * Asks like a file write (`categorizeFsMutation("write")`: silent inside
 * the workspace from level 2). ffmpeg is checked before the browser
 * starts; a missing ffmpeg or browser ends the call with how to install it.
 */
export function buildRenderHtmlTool(options: RenderHtmlToolOptions): ToolDefinition {
  const now = options.now ?? (() => new Date());
  const capture = options.capture ?? captureFrames;
  return {
    name: VIDEO_RENDER_HTML_TOOL,
    description: "Record an HTML page (a file in the working folder, or inline markup) to an .mp4 video in the working folder, frame by frame on a virtual clock, using the local browser and ffmpeg. Free, no cloud. Show it to the user by passing the returned path to reply.attachments.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: RenderHtmlArgs;
      let source: RenderSource;
      let outputPath: string;
      try {
        args = parseRenderHtmlArgs(rawArgs);
        source = resolveRenderSource(args, ctx.workingDir);
        outputPath = resolveRenderOutput(args, ctx.workingDir, now());
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const ffmpeg = options.ffmpegPath?.() ?? "ffmpeg";
      try {
        await probeFfmpeg(ffmpeg, options.spawn);
      } catch (err) {
        return errorResult(err instanceof FfmpegMissingError ? err.message : `ffmpeg could not be started: ${(err as Error).message}`, { code: "FFMPEG_MISSING" });
      }

      const category = await categorizeFsMutation("write", [outputPath], {
        workingDir: ctx.workingDir,
        ...(options.trustConfigPaths ? { trustConfigPaths: options.trustConfigPaths() } : {}),
      });
      await requireApproval(options, {
        sessionId: ctx.sessionId,
        tool: VIDEO_RENDER_HTML_TOOL,
        category,
        reason: renderHtmlApprovalReason(args, outputPath),
        affectedResources: [outputPath],
        targetPaths: [outputPath],
        workdir: ctx.workingDir,
      }, ctx.signal);

      const launch = options.launchBrowser ?? defaultBrowserLauncher(options.browserConfig?.() ?? getConfig());
      const started = Date.now();
      let lastProgress = -Infinity;
      const encoder = startFfmpegEncoder({ binary: ffmpeg, fps: args.fps, outputPath, ...(options.spawn ? { spawn: options.spawn } : {}) });
      try {
        const { pageErrors } = await capture({
          launch: async () => {
            try {
              return await launch();
            } catch (err) {
              throw new NoBrowserError(noBrowserMessage(err));
            }
          },
          source,
          width: args.width,
          height: args.height,
          fps: args.fps,
          frames: args.frames,
          signal: ctx.signal,
          onFrame: async (png, index) => {
            await encoder.write(png);
            const at = Date.now();
            if (options.onProgress && at - lastProgress >= PROGRESS_EVERY_MS) {
              lastProgress = at;
              const fraction = (index + 1) / args.frames;
              options.onProgress(ctx.sessionId, { fraction, elapsedMs: at - started, label: `recording frame ${index + 1} of ${args.frames}` });
            }
          },
        });
        await encoder.finish();
        const lines = [
          `Saved a ${args.duration}-second ${args.width}×${args.height} video (${args.frames} frames at ${args.fps} fps):`,
          `- ${outputPath}`,
          ...(pageErrors.length > 0 ? [`The page reported errors while recording: ${pageErrors.join("; ")}`] : []),
          "To show it to the user, pass this path in reply.attachments.",
        ];
        return compressToolResult({
          tool: VIDEO_RENDER_HTML_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            paths: [outputPath], kind: "local", durationMs: Date.now() - started,
            video: { width: args.width, height: args.height, fps: args.fps, frames: args.frames, durationSecs: args.duration },
          },
        }, { maxSummaryLength: 2_000, maxTailLines: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        encoder.abort();
        // The half-written file is this call's own (the path did not exist).
        await rm(outputPath, { force: true }).catch(() => {});
        if (ctx.signal.aborted) throw err;
        if (err instanceof FfmpegMissingError) return errorResult(err.message, { code: "FFMPEG_MISSING" });
        if (err instanceof NoBrowserError) return errorResult((err as Error).message, { code: "NO_BROWSER" });
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/** Why there is no browser to record with, and what to do about it. */
export function noBrowserMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/playwright/i.test(message) && /cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return "Playwright (playwright-core) is missing from this install of Atomic Agent, so no page can be recorded. Update or reinstall Atomic Agent.";
  }
  return `${/^no browser available/.test(message) ? message : `no browser available: ${message}`}. ${NO_BROWSER_HINT}`;
}

class NoBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoBrowserError";
  }
}

function errorResult(message: string, details?: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({
    tool: VIDEO_RENDER_HTML_TOOL,
    status: "error",
    output: `video.render_html: ${message}`,
    ...(details ? { details } : {}),
  });
}
