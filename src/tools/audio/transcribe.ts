import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";
import { resolveFfmpegBinary, resolveWhisperBinary, type BinaryLookupOptions } from "./whisper-binary.js";
import { installWhisperBinary, installWhisperModel, type InstallDeps } from "./whisper-install.js";
import {
  formatModelSize,
  resolveWhisperModel,
  whisperModelById,
  WHISPER_MODELS,
  whisperModelsDir,
  writeDefaultWhisperModel,
  type ModelLookupOptions,
} from "./whisper-models.js";
import { managedWhisperBinary, WHISPER_RELEASE, whisperAssetFor, whisperAssetUrl } from "./whisper-release.js";
import {
  cleanTranscript,
  ffmpegToWavArgs,
  isAudioPath,
  normalizeLanguage,
  readableWithoutFfmpeg,
  whisperCliArgs,
} from "./whisper-args.js";
import { runProcess, type RunProcess } from "./run-process.js";

export const AUDIO_TRANSCRIBE_TOOL = "audio.transcribe";

/** A converted hour of speech at 16 kHz mono is ~115 MB; whisper on CPU can take a while. */
const CONVERT_TIMEOUT_MS = 5 * 60_000;
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;
/**
 * The transcript IS the answer, so it is not cut to the compressor's
 * default 400 characters: about twenty minutes of speech fit. Errors keep
 * room for the install line and the model list.
 */
const TEXT_LIMITS = { maxSummaryLength: 16_000, maxTailLines: Number.MAX_SAFE_INTEGER };
const ERROR_LIMITS = { maxSummaryLength: 2_000, maxTailLines: Number.MAX_SAFE_INTEGER };

export interface AudioTranscribeToolOptions extends DangerousToolOptions {
  /** `config.paths.localModelsDataDir`, read per call; models go to `<it>/whisper`. */
  dataDir: () => string;
  /** Download progress for the session's UIs (`tool_progress`), like `video.generate`. */
  onProgress?: (sessionId: string, update: { fraction: number; elapsedMs: number; label: string }) => void;
  /** Test seams. */
  binaryLookup?: BinaryLookupOptions;
  modelLookup?: ModelLookupOptions;
  run?: RunProcess;
  install?: InstallDeps;
  platform?: NodeJS.Platform;
  arch?: string;
}

interface ParsedArgs {
  path: string;
  language: string;
  model: string | undefined;
  translate: boolean;
  makeDefault: boolean;
}

function parseArgs(raw: Record<string, unknown>): ParsedArgs {
  const path = raw.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("audio.transcribe: `path` must be the path of an audio file");
  }
  const language = normalizeLanguage(raw.language);
  if (language === null) {
    throw new Error("audio.transcribe: `language` must be an ISO code such as `en` or `ru`, or `auto`");
  }
  const model = raw.model;
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    throw new Error(`audio.transcribe: \`model\` must be one of ${WHISPER_MODELS.map((m) => m.id).join(", ")}`);
  }
  const makeDefault = raw.make_default === true;
  if (makeDefault && (typeof model !== "string" || !whisperModelById(model))) {
    throw new Error(`audio.transcribe: \`make_default\` needs \`model\`, one of ${WHISPER_MODELS.map((m) => m.id).join(", ")}`);
  }
  return {
    path: path.trim(),
    language,
    model: typeof model === "string" ? model.trim().toLowerCase() : undefined,
    translate: raw.translate === true,
    makeDefault,
  };
}

function errorResult(output: string, details: Record<string, unknown> = {}): CompressedToolResult {
  return compressToolResult({ tool: AUDIO_TRANSCRIBE_TOOL, status: "error", output, details }, ERROR_LIMITS);
}

function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

/**
 * `audio.transcribe { path, language?, model?, translate?, make_default? }`:
 * speech to text on this computer with whisper.cpp (ATO-702), no Python.
 *
 * What is missing is fetched on first use (decision 75), after one
 * `http` approval that names each file, its size and host: the speech
 * model (`base` unless the call or the saved default says otherwise)
 * from Hugging Face, and on Windows and Linux the pinned whisper.cpp
 * build from the upstream GitHub release. Both are checked against
 * their published SHA-256. macOS has no upstream CLI build, so there
 * the user's `brew install whisper-cpp` stays the route and a missing
 * binary answers with that line. A binary named by
 * `ATOMIC_AGENT_WHISPER_BIN` or found on PATH is used as is.
 */
export function buildAudioTranscribeTool(options: AudioTranscribeToolOptions): ToolDefinition {
  const run = options.run ?? runProcess;
  const platform = options.platform ?? options.binaryLookup?.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return {
    name: AUDIO_TRANSCRIBE_TOOL,
    description:
      "Transcribe speech in an audio file (voice message, mp3, m4a, ogg, wav, ...) to text locally with whisper.cpp.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: ParsedArgs;
      try {
        args = parseArgs(rawArgs);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const input = resolveUserPath(args.path, ctx.workingDir);
      try {
        const st = await stat(input);
        if (!st.isFile()) return errorResult(`${input} is not a file`, { path: input });
      } catch {
        return errorResult(`file not found: ${input}`, { path: input });
      }
      if (!isAudioPath(input)) {
        return errorResult(`${input} does not look like an audio file (expected .ogg, .mp3, .m4a, .wav, .flac, ...)`, { path: input });
      }

      const dataDir = options.dataDir();
      if (args.makeDefault && args.model !== undefined) {
        try {
          writeDefaultWhisperModel(dataDir, args.model);
        } catch (err) {
          return errorResult(`could not save the default speech model: ${(err as Error).message}`, { path: input });
        }
      }

      const lookup = { ...options.binaryLookup, platform };
      let whisper = resolveWhisperBinary(lookup, managedWhisperBinary(dataDir, platform));
      const asset = whisper.found ? null : whisperAssetFor(platform, arch);
      // No upstream build for this machine (macOS): the install line it is.
      if (!whisper.found && asset === null) return errorResult(whisper.reason, { path: input, missing: "whisper.cpp" });

      const model = resolveWhisperModel(dataDir, args.model, options.modelLookup);
      if (model.kind === "error") return errorResult(model.reason, { path: input });

      const ffmpeg = resolveFfmpegBinary(lookup);
      if (!ffmpeg.found && !readableWithoutFfmpeg(input)) {
        return errorResult(ffmpeg.reason, { path: input, missing: "ffmpeg" });
      }

      const fetchModel = model.kind === "download" ? model.model : null;
      if (asset !== null || fetchModel !== null) {
        const parts: string[] = [];
        const hosts: string[] = [];
        if (asset !== null) {
          parts.push(`the whisper.cpp ${WHISPER_RELEASE.version} engine (${formatModelSize(Math.ceil(asset.sizeBytes / 1_000_000))}) from github.com`);
          hosts.push("github.com");
        }
        if (fetchModel !== null) {
          parts.push(`the speech model "${fetchModel.id}" (${formatModelSize(fetchModel.sizeMb)}) from huggingface.co`);
          hosts.push("huggingface.co");
        }
        await requireApproval(options, {
          sessionId: ctx.sessionId,
          tool: AUDIO_TRANSCRIBE_TOOL,
          category: "http",
          reason: `download ${parts.join(" and ")} into ${whisperModelsDir(dataDir)}, once`,
          preview: [asset !== null ? whisperAssetUrl(asset) : null, model.kind === "download" ? model.url : null].filter((u) => u !== null).join("\n"),
          affectedResources: hosts,
        }, ctx.signal);

        // One bar for both files: bytes so far over bytes in all.
        const total = (asset?.sizeBytes ?? 0) + (fetchModel?.sizeBytes ?? 0);
        const started = Date.now();
        let doneBytes = 0;
        let lastFraction = -1;
        const report = (label: string, transferred: number) => {
          const fraction = total > 0 ? Math.min(1, (doneBytes + transferred) / total) : 0;
          if (fraction - lastFraction < 0.01 && fraction < 1) return;
          lastFraction = fraction;
          options.onProgress?.(ctx.sessionId, { fraction, elapsedMs: Date.now() - started, label });
        };
        try {
          if (asset !== null) {
            report("Downloading whisper.cpp", 0);
            const bin = await installWhisperBinary(dataDir, asset, platform, {
              signal: ctx.signal,
              deps: options.install,
              onProgress: (p) => report("Downloading whisper.cpp", p.transferred),
            });
            doneBytes += asset.sizeBytes;
            whisper = { found: true, path: bin, source: "managed" };
          }
          if (fetchModel !== null) {
            const label = `Downloading the ${fetchModel.id} speech model`;
            report(label, 0);
            await installWhisperModel(dataDir, fetchModel, {
              signal: ctx.signal,
              deps: options.install,
              onProgress: (p) => report(label, p.transferred),
            });
            doneBytes += fetchModel.sizeBytes;
          }
          report("Transcribing", 0);
        } catch (err) {
          return errorResult(`could not download what transcription needs: ${(err as Error).message}`, { path: input });
        }
      }
      if (!whisper.found) return errorResult(whisper.reason, { path: input, missing: "whisper.cpp" });
      const modelPath = model.path;
      const modelLabel = model.kind === "download" ? model.model.id : model.label;

      let workDir: string | null = null;
      try {
        let wav = input;
        if (ffmpeg.found) {
          workDir = await mkdtemp(join(tmpdir(), "atomic-transcribe-"));
          wav = join(workDir, "audio.wav");
          const conv = await run(ffmpeg.path, ffmpegToWavArgs(input, wav), { signal: ctx.signal, timeoutMs: CONVERT_TIMEOUT_MS });
          if (conv.code !== 0) {
            return errorResult(`ffmpeg could not read ${input}: ${tail(conv.stderr || conv.error || "unknown error")}`, { path: input });
          }
        }
        const res = await run(
          whisper.path,
          whisperCliArgs({ model: modelPath, wav, language: args.language, translate: args.translate }),
          { signal: ctx.signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
        );
        if (res.code !== 0) {
          return errorResult(`whisper.cpp failed: ${tail(res.stderr || res.error || "unknown error")}`, { path: input, model: modelLabel });
        }
        const text = cleanTranscript(res.stdout);
        const details = { path: input, model: modelLabel, language: args.language, chars: text.length };
        if (text.length === 0) {
          return compressToolResult({ tool: AUDIO_TRANSCRIBE_TOOL, status: "ok", output: "(no speech recognised)", details });
        }
        return compressToolResult({ tool: AUDIO_TRANSCRIBE_TOOL, status: "ok", output: text, details }, TEXT_LIMITS);
      } finally {
        if (workDir !== null) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}
