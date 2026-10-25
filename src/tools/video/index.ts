import type { ToolRegistry } from "../tool-registry.js";
import { buildVideoGenerateTool, type VideoGenerateToolOptions } from "./generate.js";

export { buildVideoGenerateTool, VIDEO_GENERATE_TOOL, videoApprovalReason } from "./generate.js";
export type { VideoGenerateToolOptions, VideoProgressUpdate } from "./generate.js";
export { parseVideoArgs, VIDEO_ASPECTS, VIDEO_DEFAULT_DURATION, VIDEO_DURATION_MAX, VIDEO_RESOLUTIONS } from "./args.js";
export type { VideoArgs, VideoAspect } from "./args.js";
export { fitVideoToModel } from "./fit-model.js";

/**
 * Register `video.generate`. Always registered: whether the prompt
 * offers it is decided per rebuild by the `video` gate
 * (`filter-disabled-tools.ts`), so adding an OpenRouter key mid-session
 * makes it available without a restart.
 */
export function registerVideoTools(registry: ToolRegistry, options: VideoGenerateToolOptions): void {
  registry.register(buildVideoGenerateTool(options));
}
