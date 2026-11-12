import type { ToolRegistry } from "../tool-registry.js";
import { buildVideoGenerateTool, type VideoGenerateToolOptions } from "./generate.js";
import { buildRenderHtmlTool, type RenderHtmlToolOptions } from "./render-html.js";

export { buildVideoGenerateTool, VIDEO_GENERATE_TOOL, videoApprovalReason } from "./generate.js";
export type { VideoGenerateToolOptions, VideoProgressUpdate } from "./generate.js";
export { parseVideoArgs, VIDEO_ASPECTS, VIDEO_DEFAULT_DURATION, VIDEO_DURATION_MAX, VIDEO_RESOLUTIONS } from "./args.js";
export type { VideoArgs, VideoAspect } from "./args.js";
export { fitVideoToModel } from "./fit-model.js";
export { buildRenderHtmlTool, VIDEO_RENDER_HTML_TOOL } from "./render-html.js";
export type { RenderHtmlProgress, RenderHtmlToolOptions } from "./render-html.js";
export { parseRenderHtmlArgs } from "./render-html-args.js";

/**
 * Register `video.generate` and `video.render_html`. Both always
 * registered. Whether the prompt offers `video.generate` is decided per
 * rebuild by the `video` gate (`filter-disabled-tools.ts`), so adding an
 * OpenRouter key mid-session makes it available without a restart.
 * `video.render_html` needs no key (local browser + ffmpeg) and is not
 * gated; it reports a missing browser or ffmpeg when called.
 */
export function registerVideoTools(
  registry: ToolRegistry,
  options: VideoGenerateToolOptions & { renderHtml?: Omit<RenderHtmlToolOptions, "approvals" | "approvalRequired"> },
): void {
  registry.register(buildVideoGenerateTool(options));
  registry.register(buildRenderHtmlTool({
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
    ...options.renderHtml,
  }));
}
