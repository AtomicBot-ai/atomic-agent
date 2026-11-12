import type { ToolRegistry } from "../tool-registry.js";
import type { VisionProviderSource } from "../vision/describe.js";
import { buildAudioListenTool } from "./listen.js";

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

export interface RegisterAudioToolsOptions {
  provider: VisionProviderSource | undefined;
  /** `config.vision.audioInput` — opt-in, default off. */
  enabled: boolean;
  maxAudioBytes: number;
}

/**
 * Register `audio.listen` when audio input is switched on and some
 * provider is wired. Like vision, the model's capability is checked per
 * call, not here: a local model swap can turn it on or off mid-session.
 */
export function registerAudioTools(
  registry: ToolRegistry,
  options: RegisterAudioToolsOptions,
): void {
  if (!options.enabled || !options.provider) return;
  registry.register(
    buildAudioListenTool({
      provider: options.provider,
      maxAudioBytes: options.maxAudioBytes,
    }),
  );
}
