import type { ToolRegistry } from "../tool-registry.js";
import { buildImageGenerateTool, type ImageGenerateToolOptions } from "./generate.js";

export { buildImageGenerateTool, cloudAspectRatio, cloudBatches, IMAGE_COUNT_MAX, IMAGE_GENERATE_TOOL, IMAGE_PARALLEL_JOBS } from "./generate.js";
export { coreDownloadProgress } from "./core-download-progress.js";
export type { MediaProgressUpdate } from "./core-download-progress.js";
export type { ImageGenerateToolOptions } from "./generate.js";
export { openRouterImageKey } from "./openrouter-key.js";

/**
 * Register `image.generate`. Always registered: whether the prompt
 * offers it is decided per rebuild by the `image` gate
 * (`filter-disabled-tools.ts`), so adding an OpenRouter key mid-session
 * makes it available without a restart.
 */
export function registerImageTools(registry: ToolRegistry, options: ImageGenerateToolOptions): void {
  registry.register(buildImageGenerateTool(options));
}
