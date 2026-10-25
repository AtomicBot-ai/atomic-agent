import { join, relative } from "node:path";
import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import {
  captureGeometry,
  fitWithin,
  SCREENSHOT_MAX_SIDE,
  type ScreenGeometryStore,
} from "./screen-geometry.js";
import {
  macOnlyMessage,
  runScreenOp,
  screenRecordingMessage,
  type ScreenDeps,
} from "./screen-host.js";

export const OS_SCREEN_CAPTURE_TOOL = "os.screen.capture";

/** Folder (under the working directory) the screenshots are saved in. */
export const SCREENSHOT_DIR = ".atomic-screens";

/** The whole message must reach the model: it says what to do next. */
const SCREEN_RESULT_OPTIONS = { maxSummaryLength: 1_200, maxTailLines: 40 } as const;

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OsScreenCaptureOptions {
  deps: ScreenDeps;
  geometry: ScreenGeometryStore;
}

/**
 * `os.screen.capture { region? }` — a JPEG of the main screen (or a
 * region of it, in screen points) saved under `.atomic-screens/` in the
 * working folder. Tool results are text, so the picture reaches a model
 * the way every other image does: by path, through `vision.describe`
 * (or `reply.attachments` to show it to the user). The result carries
 * the scale that maps the image's pixels back to screen points, and
 * the session remembers it for `os.screen.click`.
 */
export function buildOsScreenCaptureTool(
  options: OsScreenCaptureOptions,
): ToolDefinition {
  const { deps } = options;
  return {
    name: OS_SCREEN_CAPTURE_TOOL,
    description:
      "Take a screenshot of the main screen (macOS). Saves a JPEG in the working folder and returns its path, size and the pixel-to-point scale; look at it with vision.describe, then click with os.screen.click using the image's pixel coordinates.",
    readonly: true,
    async run(rawArgs, ctx) {
      if (deps.platform !== "darwin") {
        return errorResult(macOnlyMessage(OS_SCREEN_CAPTURE_TOOL, deps.platform));
      }
      let region: ScreenRegion | undefined;
      try {
        region = parseRegion(rawArgs.region);
      } catch (error) {
        return errorResult((error as Error).message);
      }
      try {
        return await capture(options, region, ctx);
      } catch (error) {
        return errorResult(`screenshot failed: ${(error as Error).message}`);
      }
    },
  };
}

async function capture(
  { deps, geometry }: OsScreenCaptureOptions,
  region: ScreenRegion | undefined,
  ctx: { workingDir: string; sessionId: string; signal: AbortSignal },
): Promise<CompressedToolResult> {
  const probe = await runScreenOp(deps, { op: "probe" }, ctx);
  if (probe.screenRecording === false) {
    return errorResult(screenRecordingMessage(deps.env), {
      retryable: false,
      reason: "screen-recording-permission",
    });
  }
  const area = region ?? { x: 0, y: 0, width: probe.screen.width, height: probe.screen.height };
  if (
    area.x + area.width > probe.screen.width + 0.5 ||
    area.y + area.height > probe.screen.height + 0.5
  ) {
    return errorResult(
      `region ${describeRegion(area)} does not fit the main screen (${probe.screen.width}x${probe.screen.height} points)`,
    );
  }

  const dir = join(ctx.workingDir, SCREENSHOT_DIR);
  await deps.ensureDir(dir);
  const path = join(dir, `screen-${stamp(deps.now())}.jpg`);
  const shot = await deps.run("screencapture", screencaptureArgs(path, region), {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: 20_000,
  });
  const bytes = shot.exitCode === 0 ? await deps.fileSize(path).catch(() => 0) : 0;
  if (bytes === 0) {
    const why = shot.stderr.trim() || `screencapture exit ${shot.exitCode ?? "none"}`;
    return errorResult(`screenshot failed: ${why}. ${screenRecordingMessage(deps.env)}`, {
      retryable: false,
      reason: "capture-failed",
    });
  }

  const size = await readPixelSize(deps, path, ctx);
  const fit = fitWithin(size.width, size.height);
  if (fit.resize) {
    const resized = await deps.run("sips", ["-Z", String(SCREENSHOT_MAX_SIDE), path], {
      cwd: ctx.workingDir,
      signal: ctx.signal,
      timeoutMs: 20_000,
    });
    if (resized.exitCode !== 0) {
      return errorResult(`downscaling the screenshot failed: ${resized.stderr.trim()}`);
    }
  }
  const image = fit.resize ? await readPixelSize(deps, path, ctx) : size;
  const mapped = captureGeometry(area, image);
  geometry.set(ctx.sessionId, mapped);

  const shown = relative(ctx.workingDir, path);
  const front = probe.frontmost?.name ?? "unknown";
  const lines = [
    `saved ${shown} (${image.width}x${image.height} px) of ${region ? `region ${describeRegion(area)}` : "the main screen"}` +
      ` (${probe.screen.width}x${probe.screen.height} points); frontmost app: ${front}.`,
    `scale ${mapped.scale.toFixed(4)} image px per screen point${region ? `, origin ${area.x},${area.y}` : ""}.`,
    `Look at it with vision.describe { "path": "${shown}" }. Give os.screen.click the image's pixel x,y as they are; this capture's scale and origin are remembered.`,
  ];
  if (probe.screenRecording === null) {
    lines.push(
      "Screen Recording permission could not be checked: if the picture shows only the desktop background, the permission is missing.",
    );
  }
  return compressToolResult(
    {
      tool: OS_SCREEN_CAPTURE_TOOL,
      status: "ok",
      output: lines.join("\n"),
      details: {
        path,
        imageWidth: image.width,
        imageHeight: image.height,
        scale: mapped.scale,
        originX: mapped.originX,
        originY: mapped.originY,
        screenWidth: probe.screen.width,
        screenHeight: probe.screen.height,
        frontmost: probe.frontmost,
        bytes,
      },
    },
    SCREEN_RESULT_OPTIONS,
  );
}

/** `screencapture -x -t jpg [-R x,y,w,h] <path>`: silent, JPEG, main display. */
export function screencaptureArgs(path: string, region?: ScreenRegion): string[] {
  const args = ["-x", "-t", "jpg"];
  if (region) {
    args.push("-R", [region.x, region.y, region.width, region.height].join(","));
  }
  args.push(path);
  return args;
}

export function parseRegion(raw: unknown): ScreenRegion | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("`region` must be an object { x, y, width, height } in screen points");
  }
  const r = raw as Record<string, unknown>;
  const values = [r.x, r.y, r.width, r.height];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new Error("`region` needs numeric x, y, width and height (screen points)");
  }
  const [x, y, width, height] = values as number[];
  if (x! < 0 || y! < 0 || width! <= 0 || height! <= 0) {
    throw new Error("`region` x and y must be >= 0 and width, height > 0");
  }
  return { x: Math.round(x!), y: Math.round(y!), width: Math.round(width!), height: Math.round(height!) };
}

async function readPixelSize(
  deps: ScreenDeps,
  path: string,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<{ width: number; height: number }> {
  const result = await deps.run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: 10_000,
  });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(result.stdout)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(result.stdout)?.[1]);
  if (result.exitCode !== 0 || !(width > 0) || !(height > 0)) {
    throw new Error(`could not read the screenshot size: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { width, height };
}

function describeRegion(r: ScreenRegion): string {
  return `${r.x},${r.y} ${r.width}x${r.height}`;
}

/** `20261025-142233-417`: milliseconds keep a fast capture loop from colliding. */
function stamp(now: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  );
}

function errorResult(message: string, details: Record<string, unknown> = {}) {
  return compressToolResult(
    { tool: OS_SCREEN_CAPTURE_TOOL, status: "error", output: message, details },
    SCREEN_RESULT_OPTIONS,
  );
}
