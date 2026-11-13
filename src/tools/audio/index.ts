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
      ...(options.allowProvider ? { allowProvider: options.allowProvider } : {}),
    }),
  );
}
