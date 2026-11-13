import type { ToolRegistry } from "../tool-registry.js";
import type { VisionProviderSource } from "../vision/describe.js";
import { buildAudioTranscribeTool, type AudioTranscribeToolOptions } from "./transcribe.js";
import { buildAudioListenTool, type AudioListenToolOptions } from "./listen.js";

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

export {
  AUDIO_LISTEN_TOOL,
  buildAudioListenTool,
  DEFAULT_AUDIO_PROMPT,
} from "./listen.js";
export type { AudioListenToolOptions } from "./listen.js";
export {
  AUDIO_SNIFF_PREFIX_BYTES,
  AudioTooLargeError,
  loadAudioFile,
  NotARegularAudioFileError,
  sniffAudioFormat,
  UnsupportedAudioFormatError,
} from "./load-audio.js";
export type { LoadedAudio } from "./load-audio.js";

export interface RegisterAudioListenToolsOptions {
  provider: VisionProviderSource | undefined;
  /** `config.vision.audioInput !== false` (unset is auto, ATO-497 decision 62). */
  enabled: boolean;
  maxAudioBytes: number;
  /**
   * Whether audio may be sent to this provider at all (auto mode keeps
   * cloud links out). Absent: every provider.
   */
  allowProvider?: AudioListenToolOptions["allowProvider"];
}

/**
 * Register `audio.listen` (ATO-497; `registerAudioTools` above is
 * `audio.transcribe`, ATO-702) when audio input is switched on and some
 * provider is wired. Like vision, the model's capability is checked per
 * call, not here: a local model swap can turn it on or off mid-session.
 */
export function registerAudioListenTools(
  registry: ToolRegistry,
  options: RegisterAudioListenToolsOptions,
): void {
  if (!options.enabled || !options.provider) return;
  registry.register(
    buildAudioListenTool({
      provider: options.provider,
      maxAudioBytes: options.maxAudioBytes,
      ...(options.allowProvider ? { allowProvider: options.allowProvider } : {}),
    }),
  );
}
