import type { ToolRegistry } from "../tool-registry.js";
import { buildAudioTranscribeTool, type AudioTranscribeToolOptions } from "./transcribe.js";

export { AUDIO_TRANSCRIBE_TOOL, buildAudioTranscribeTool } from "./transcribe.js";
export type { AudioTranscribeToolOptions } from "./transcribe.js";
export {
  FFMPEG_BIN_ENV,
  findExecutable,
  resolveFfmpegBinary,
  resolveWhisperBinary,
  WHISPER_BIN_ENV,
  WHISPER_BINARY_NAMES,
} from "./whisper-binary.js";
export type { BinaryLookupOptions, BinaryResolution } from "./whisper-binary.js";
export {
  DEFAULT_WHISPER_MODEL,
  resolveWhisperModel,
  WHISPER_MODEL_ENV,
  WHISPER_MODELS,
  whisperModelPath,
  whisperModelUrl,
} from "./whisper-models.js";
export type { ModelResolution, WhisperModel } from "./whisper-models.js";
export { ffmpegToWavArgs, whisperCliArgs, cleanTranscript } from "./whisper-args.js";

/**
 * Register `audio.transcribe`. Always registered and offered: without
 * whisper.cpp the call answers with the install line, which is what the
 * agent needs to tell the user.
 */
export function registerAudioTools(registry: ToolRegistry, options: AudioTranscribeToolOptions): void {
  registry.register(buildAudioTranscribeTool(options));
}
