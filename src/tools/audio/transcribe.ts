import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { downloadFile } from "../../local-llm/downloads/download-file.js";
import { resolveUserPath } from "../os/expand-home.js";
import type { ToolDefinition } from "../tool-registry.js";
import { resolveFfmpegBinary, resolveWhisperBinary, type BinaryLookupOptions } from "./whisper-binary.js";
import {
  formatModelSize,
  resolveWhisperModel,
  WHISPER_MODELS,
  type ModelLookupOptions,
} from "./whisper-models.js";
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
  /** Test seams. */
  binaryLookup?: BinaryLookupOptions;
  modelLookup?: ModelLookupOptions;
  run?: RunProcess;
  download?: (url: string, dest: string, signal: AbortSignal) => Promise<void>;
}

interface ParsedArgs {
  path: string;
  language: string;
  model: string | undefined;
  translate: boolean;
  download: boolean;
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
  return {
    path: path.trim(),
    language,
    model: typeof model === "string" ? model.trim() : undefined,
    translate: raw.translate === true,
    download: raw.download === true,
  };
}

function errorResult(output: string, details: Record<string, unknown> = {}): CompressedToolResult {
  return compressToolResult({ tool: AUDIO_TRANSCRIBE_TOOL, status: "error", output, details }, ERROR_LIMITS);
}

function tail(text: string, max = 600): string {
  const t = text.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

const defaultDownload = (url: string, dest: string, signal: AbortSignal) => downloadFile(url, dest, { signal });

/**
 * `audio.transcribe { path, language?, model?, translate?, download? }` —
 * speech to text on this computer with whisper.cpp (ATO-702), no Python.
 *
 * Uses the user's own `whisper-cli` and `ffmpeg` (PATH or the
 * `ATOMIC_AGENT_WHISPER_BIN` / `ATOMIC_AGENT_FFMPEG_BIN` variables).
 * The speech model is a ggml file from Hugging Face; when it is not on
 * disk yet the first call answers with its size and the agent asks the
 * user, then calls again with `download: true`, which asks for approval
 * (`http`) before fetching it.
 */
export function buildAudioTranscribeTool(options: AudioTranscribeToolOptions): ToolDefinition {
  const run = options.run ?? runProcess;
  const download = options.download ?? defaultDownload;
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

      const whisper = resolveWhisperBinary(options.binaryLookup);
      if (!whisper.found) return errorResult(whisper.reason, { path: input, missing: "whisper.cpp" });

      const model = resolveWhisperModel(options.dataDir(), args.model, options.modelLookup);
      if (model.kind === "error") return errorResult(model.reason, { path: input });
      let modelPath: string;
      let modelLabel: string;
      if (model.kind === "download") {
        const size = formatModelSize(model.model.sizeMb);
        if (!args.download) {
          return errorResult(
            `The speech model "${model.model.id}" (${size}) is not downloaded yet. Ask the user whether to download it ` +
              `from huggingface.co (${size}, once), then call audio.transcribe again with "download": true. ` +
              `Smaller and larger models: ${WHISPER_MODELS.map((m) => `${m.id} ${formatModelSize(m.sizeMb)}`).join(", ")}.`,
            { path: input, model: model.model.id, sizeMb: model.model.sizeMb, needsDownload: true },
          );
        }
        await requireApproval(options, {
          sessionId: ctx.sessionId,
          tool: AUDIO_TRANSCRIBE_TOOL,
          category: "http",
          reason: `download the whisper speech model "${model.model.id}" (${size}) from huggingface.co into ${dirname(model.path)}`,
          preview: model.url,
          affectedResources: ["huggingface.co"],
        }, ctx.signal);
        try {
          await mkdir(dirname(model.path), { recursive: true });
          await download(model.url, model.path, ctx.signal);
        } catch (err) {
          return errorResult(`could not download the speech model: ${(err as Error).message}`, { path: input, model: model.model.id });
        }
        modelPath = model.path;
        modelLabel = model.model.id;
      } else {
        modelPath = model.path;
        modelLabel = model.label;
      }

      const ffmpeg = resolveFfmpegBinary(options.binaryLookup);
      if (!ffmpeg.found && !readableWithoutFfmpeg(input)) {
        return errorResult(ffmpeg.reason, { path: input, missing: "ffmpeg" });
      }

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
