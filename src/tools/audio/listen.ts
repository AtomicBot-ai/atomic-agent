import { compressToolResult } from "../../compressor/result-compressor.js";
import { AudioUnsupportedError, type LlmProvider } from "../../llm/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import type { VisionProviderSource } from "../vision/describe.js";
import {
  AudioTooLargeError,
  loadAudioFile,
  NotARegularAudioFileError,
  UnsupportedAudioFormatError,
  type LoadedAudio,
} from "./load-audio.js";

export const AUDIO_LISTEN_TOOL = "audio.listen";

/** What the model is asked when the call names no prompt. */
export const DEFAULT_AUDIO_PROMPT =
  "Transcribe the speech in this audio word for word, then note anything else in it that matters (music, noises, tone).";

/** A transcript is prose: keep it whole up to the render cap, like vision. */
const AUDIO_COMPRESSOR_OPTIONS = {
  maxSummaryLength: 8_000,
  maxTailLines: Number.MAX_SAFE_INTEGER,
} as const;

export interface AudioListenToolOptions {
  /** Same source as `vision.describe`: fixed, or looked up per call. */
  provider: VisionProviderSource;
  /** `config.vision.maxAudioBytes`. */
  maxAudioBytes: number;
}

/**
 * `audio.listen { path, prompt? }` (ATO-497) — hand a WAV or MP3 file to
 * the chat model serving this step as an `input_audio` part, when that
 * model takes audio (`capabilities.audio`: llama-server `/props`, the
 * operator's `supportsAudio`, or OpenRouter's model list). Otherwise it
 * refuses without a call and points at today's path: the file is on
 * disk, and the `audio-transcribe` skill turns it into text locally.
 * Video has no OpenAI-compatible input part, so it is not handled here.
 */
export function buildAudioListenTool(options: AudioListenToolOptions): ToolDefinition {
  return {
    name: AUDIO_LISTEN_TOOL,
    description:
      "Listen to a WAV or MP3 file with the current model, when it takes audio input. Use for a voice message or recording the user attached. If the model cannot hear, use the audio-transcribe skill instead.",
    readonly: true,
    async run(rawArgs, ctx) {
      const path = typeof rawArgs.path === "string" ? rawArgs.path.trim() : "";
      if (path.length === 0) {
        return errorResult("audio.listen: `path` must name an audio file");
      }
      const prompt =
        typeof rawArgs.prompt === "string" && rawArgs.prompt.trim().length > 0
          ? rawArgs.prompt.trim()
          : DEFAULT_AUDIO_PROMPT;
      const provider =
        typeof options.provider === "function"
          ? options.provider(ctx.providerId)
          : options.provider;
      if (provider === undefined) {
        return errorResult(
          `audio is not available: provider "${ctx.providerId ?? "(active)"}" is not configured`,
        );
      }
      if (provider.capabilities.audio !== true || !provider.describeAudio) {
        return cannotHearResult(provider, path);
      }
      let loaded: LoadedAudio;
      try {
        loaded = await loadAudioFile(path, ctx.workingDir, options.maxAudioBytes);
      } catch (error) {
        if (
          error instanceof UnsupportedAudioFormatError ||
          error instanceof AudioTooLargeError ||
          error instanceof NotARegularAudioFileError
        ) {
          return errorResult(error.message);
        }
        return errorResult(`failed to load audio: ${(error as Error).message}`);
      }
      try {
        const result = await provider.describeAudio({
          prompt,
          audio: { bytes: loaded.bytes, format: loaded.format },
          signal: ctx.signal,
        });
        return compressToolResult(
          {
            tool: AUDIO_LISTEN_TOOL,
            status: "ok",
            output: result.text,
            details: {
              provider: provider.name,
              path: loaded.path,
              bytes: loaded.bytes.byteLength,
              format: loaded.format,
              durationMs: result.durationMs,
            },
          },
          AUDIO_COMPRESSOR_OPTIONS,
        );
      } catch (error) {
        if (error instanceof AudioUnsupportedError) {
          return cannotHearResult(provider, path);
        }
        return errorResult(`audio call failed: ${(error as Error).message}`);
      }
    },
  };
}

function errorResult(message: string, details?: Record<string, unknown>) {
  return compressToolResult(
    {
      tool: AUDIO_LISTEN_TOOL,
      status: "error",
      output: message,
      ...(details ? { details } : {}),
    },
    AUDIO_COMPRESSOR_OPTIONS,
  );
}

/**
 * The model serving this step takes no audio. Not retryable on this
 * model; the way forward is the transcription path that already exists.
 */
function cannotHearResult(provider: LlmProvider, path: string) {
  const providerId = provider.id ?? provider.name;
  const model = provider.chatModelId;
  const who = model ? `${model} on ${providerId}` : `the model on ${providerId}`;
  return errorResult(
    `${who} does not take audio input. Do not call audio.listen again on this model: ` +
      `transcribe ${path} with the audio-transcribe skill instead (local whisper), then work from the text.`,
    {
      retryable: false,
      reason: "model-cannot-hear",
      provider: providerId,
      ...(model ? { model } : {}),
      audioSource: provider.capabilities.audioSource ?? "absent",
    },
  );
}
