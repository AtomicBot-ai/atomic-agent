/**
 * `video.render_html` arguments: parsed before anything is launched or
 * asked. The plain JSON schema (`default-tool-args-schemas.ts`) only says
 * the types; the bounds live here, so a call that would hold the browser
 * for an hour or write a 4K stream is refused with a sentence the agent
 * can act on.
 */

export const RENDER_HTML_DEFAULT_DURATION = 5;
export const RENDER_HTML_DURATION_MAX = 60;
export const RENDER_HTML_DEFAULT_FPS = 30;
export const RENDER_HTML_FPS_MAX = 60;
export const RENDER_HTML_DEFAULT_WIDTH = 1280;
export const RENDER_HTML_DEFAULT_HEIGHT = 720;
export const RENDER_HTML_SIDE_MIN = 64;
export const RENDER_HTML_SIDE_MAX = 1920;
/** 1920×1080 worth of pixels, either way round. */
export const RENDER_HTML_PIXELS_MAX = 1920 * 1080;
/** Every frame is one screenshot; this bounds the whole run. */
export const RENDER_HTML_FRAMES_MAX = 1800;
/** Inline markup bigger than this belongs in a file. */
const HTML_MAX_CHARS = 500_000;

export interface RenderHtmlArgs {
  /** A page in the working folder, as the agent wrote it (resolved later). */
  path?: string;
  /** Inline markup, when there is no file. Exactly one of `path` / `html`. */
  html?: string;
  /** Seconds of animation to record. */
  duration: number;
  fps: number;
  width: number;
  height: number;
  /** Total frames: `round(duration * fps)`, at least 1. */
  frames: number;
  /** The `.mp4` to write, as the agent wrote it; absent means a fresh name. */
  output?: string;
}

function optionalString(raw: unknown, name: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) throw new Error(`\`${name}\` must be a non-empty string`);
  return raw;
}

function boundedNumber(
  raw: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || (integer && !Number.isInteger(raw)) || raw < min || raw > max) {
    throw new Error(`\`${name}\` must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}`);
  }
  return raw;
}

/** Throws an `Error` whose message is the sentence the agent sees. */
export function parseRenderHtmlArgs(raw: Record<string, unknown>): RenderHtmlArgs {
  const path = optionalString(raw.path, "path");
  let html: string | undefined;
  if (raw.html !== undefined && raw.html !== null && raw.html !== "") {
    if (typeof raw.html !== "string") throw new Error("`html` must be a string of HTML markup");
    html = raw.html;
  }
  if ((path === undefined) === (html === undefined)) {
    throw new Error("pass exactly one of `path` (an .html file in the working folder) or `html` (the markup itself)");
  }
  if (path !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(path.trim())) {
    throw new Error("`path` must be a local .html file in the working folder, not a URL");
  }
  if (path !== undefined && !/\.html?$/i.test(path.trim())) {
    throw new Error("`path` must name an .html file");
  }
  if (html !== undefined && html.length > HTML_MAX_CHARS) {
    throw new Error(`\`html\` is longer than ${HTML_MAX_CHARS} characters; save it to a file and pass \`path\``);
  }

  const duration = boundedNumber(raw.duration, "duration", RENDER_HTML_DEFAULT_DURATION, 0.1, RENDER_HTML_DURATION_MAX, false);
  const fps = boundedNumber(raw.fps, "fps", RENDER_HTML_DEFAULT_FPS, 1, RENDER_HTML_FPS_MAX, true);
  const width = evenSide(boundedNumber(raw.width, "width", RENDER_HTML_DEFAULT_WIDTH, RENDER_HTML_SIDE_MIN, RENDER_HTML_SIDE_MAX, true));
  const height = evenSide(boundedNumber(raw.height, "height", RENDER_HTML_DEFAULT_HEIGHT, RENDER_HTML_SIDE_MIN, RENDER_HTML_SIDE_MAX, true));
  if (width * height > RENDER_HTML_PIXELS_MAX) {
    throw new Error(`${width}×${height} is more than 1920×1080 worth of pixels; lower \`width\` or \`height\``);
  }
  const frames = Math.max(1, Math.round(duration * fps));
  if (frames > RENDER_HTML_FRAMES_MAX) {
    throw new Error(`${duration} s at ${fps} fps is ${frames} frames, over the limit of ${RENDER_HTML_FRAMES_MAX}; lower \`fps\` or \`duration\``);
  }

  const output = optionalString(raw.output, "output");
  if (output !== undefined && !/\.mp4$/i.test(output.trim())) {
    throw new Error("`output` must be a file name ending in .mp4");
  }

  return {
    ...(path !== undefined ? { path: path.trim() } : {}),
    ...(html !== undefined ? { html } : {}),
    duration, fps, width, height, frames,
    ...(output !== undefined ? { output: output.trim() } : {}),
  };
}

/** H.264 in yuv420p needs even sides; an odd one is rounded down. */
function evenSide(n: number): number {
  return n % 2 === 0 ? n : n - 1;
}
