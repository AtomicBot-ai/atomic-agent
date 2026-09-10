import type { ToolRegistry } from "../tool-registry.js";
import type { LlmProvider } from "../../llm/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { buildVisionDescribeTool } from "./describe.js";

export { buildVisionDescribeTool } from "./describe.js";
export { loadImageFile, UnsupportedImageFormatError } from "./load-image.js";
export type { LoadedImage, MimeTypeSource } from "./load-image.js";
export {
  sniffImageType,
  IMAGE_SNIFF_PREFIX_BYTES,
} from "./sniff-image-type.js";
export type { SniffedImageType } from "./sniff-image-type.js";

export interface RegisterVisionToolsOptions {
  provider: LlmProvider | undefined;
  enabled: boolean;
  maxImagesPerCall: number;
  maxImageBytes: number;
  logger?: StructuredLogger | undefined;
}

/**
 * Register the multimodal toolset. The tool is **not** registered only
 * when vision is disabled by config or when there is no vision-capable
 * provider wired at all. The provider's `capabilities.vision` flag is
 * **not** consulted here — capabilities are dynamic (driven by
 * `ModelProfileManager` hot-swap) and may flip from `false` to `true`
 * after the first `/props` probe lands. The runtime check happens
 * inside the tool itself (`describeImage` raises
 * `VisionUnsupportedError` when capabilities are still false) so a
 * deferred health probe never traps the session in a vision-less
 * state.
 */
export function registerVisionTools(
  registry: ToolRegistry,
  options: RegisterVisionToolsOptions,
): void {
  if (!options.enabled) return;
  if (!options.provider) return;
  registry.register(
    buildVisionDescribeTool({
      provider: options.provider,
      maxImagesPerCall: options.maxImagesPerCall,
      maxImageBytes: options.maxImageBytes,
      logger: options.logger,
    }),
  );
}
