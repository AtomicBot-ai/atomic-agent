import { join } from "node:path";
import {
  ApprovalDeniedError,
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
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
import { screenChildEnv } from "./screen-jxa.js";

export const OS_SCREEN_CAPTURE_TOOL = "os.screen.capture";

/** Folder under `os.tmpdir()` the screenshots are saved in, one subfolder per session. */
export const SCREENSHOT_DIR = "atomic-agent-screens";

/** `<tmp>/atomic-agent-screens/<session>`: outside the working folder, inside the read roots. */
export function screenshotDir(tmpDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  return join(tmpDir, SCREENSHOT_DIR, safe === "." || safe === ".." ? "default" : safe);
}

export const CAPTURE_NEEDS_OVERLAY_MESSAGE =
  "Screen control is off (tools.screen.enabled), so screenshots are only taken to point at things in the Atomic Agent desktop app, and this chat is not in it. Nothing was captured: ask the user to describe what they see.";

/** The whole message must reach the model: it says what to do next. */
const SCREEN_RESULT_OPTIONS = { maxSummaryLength: 1_200, maxTailLines: 40 } as const;

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OsScreenCaptureOptions extends DangerousToolOptions {
  deps: ScreenDeps;
  geometry: ScreenGeometryStore;
  /**
   * ATO-1018: set when capture is registered only for `os.screen.point`
   * (`tools.screen.point` without `tools.screen.enabled`). It then runs
   * only for a session whose host draws marks (the desktop app's own
   * chat); a terminal, a channel or a scheduled task is refused, so
   * pointing never widens where screenshots can be taken.
   */
  onlyWithOverlay?: (sessionId: string) => boolean;
}

/**
 * `os.screen.capture { x?, y?, width?, height? }` — a JPEG of the primary display (or a
 * region of it, in screen points) saved under the temp folder, so the
 * working folder never fills with screenshots and the tool stays
 * read-only. It asks as `screen_capture` below approval level 3. Tool results are text, so the picture reaches a model
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
      "Take a screenshot of the primary display (macOS). Saves a JPEG in the temp folder and returns its path, size and the pixel-to-point scale; look at it with vision.describe, then click with os.screen.click using the image's pixel coordinates. May ask the user first.",
    readonly: true,
    async run(rawArgs, ctx) {
      if (deps.platform !== "darwin") {
        return errorResult(macOnlyMessage(OS_SCREEN_CAPTURE_TOOL, deps.platform));
      }
      if (options.onlyWithOverlay && !options.onlyWithOverlay(ctx.sessionId)) {
        return errorResult(CAPTURE_NEEDS_OVERLAY_MESSAGE, { retryable: false, reason: "no-overlay" });
      }
      let region: ScreenRegion | undefined;
      try {
        region = parseRegion(rawArgs.region ?? flatRegion(rawArgs));
      } catch (error) {
        return errorResult((error as Error).message);
      }
      try {
        return await capture(options, region, ctx);
      } catch (error) {
        // A denial is the user's decision: it propagates like every gated tool's.
        if (error instanceof ApprovalDeniedError) throw error;
        return errorResult(`screenshot failed: ${(error as Error).message}`);
      }
    },
  };
}

async function capture(
  options: OsScreenCaptureOptions,
  region: ScreenRegion | undefined,
  ctx: { workingDir: string; sessionId: string; signal: AbortSignal },
): Promise<CompressedToolResult> {
  const { deps, geometry } = options;
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
      `region ${describeRegion(area)} does not fit the primary display (${probe.screen.width}x${probe.screen.height} points)`,
    );
  }

  const front = probe.frontmost?.name ?? "unknown";
  const what = region ? `region ${describeRegion(area)} of the primary display` : "the primary display";
  await requireApproval(
    options,
    {
      sessionId: ctx.sessionId,
      tool: OS_SCREEN_CAPTURE_TOOL,
      category: "screen_capture",
      reason: `take a screenshot of ${what}`,
      preview: `${OS_SCREEN_CAPTURE_TOOL}: screenshot of ${what}\nfrontmost app: ${front}`,
      affectedResources: ["screen"],
    },
    ctx.signal,
  );

  const env = screenChildEnv(deps.env);
  const dir = screenshotDir(deps.tmpDir, ctx.sessionId);
  await deps.ensureDir(dir);
  const path = join(dir, `screen-${stamp(deps.now())}.jpg`);
  const shot = await deps.run("screencapture", screencaptureArgs(path, region), {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: 20_000,
    env,
  });
  const bytes = shot.exitCode === 0 ? await deps.fileSize(path).catch(() => 0) : 0;
  if (bytes === 0) {
    const why = shot.stderr.trim() || `screencapture exit ${shot.exitCode ?? "none"}`;
    return errorResult(`screenshot failed: ${why}. ${screenRecordingMessage(deps.env)}`, {
      retryable: false,
      reason: "capture-failed",
    });
  }

  const size = await readPixelSize(deps, path, ctx, env);
  const fit = fitWithin(size.width, size.height);
  if (fit.resize) {
    const resized = await deps.run("sips", ["-Z", String(SCREENSHOT_MAX_SIDE), path], {
      cwd: ctx.workingDir,
      signal: ctx.signal,
      timeoutMs: 20_000,
      env,
    });
    if (resized.exitCode !== 0) {
      return errorResult(`downscaling the screenshot failed: ${resized.stderr.trim()}`);
    }
  }
  const image = fit.resize ? await readPixelSize(deps, path, ctx, env) : size;
  const mapped = captureGeometry(area, image);
  geometry.set(ctx.sessionId, mapped);

  const shown = path;
  const lines = [
    `saved ${shown} (${image.width}x${image.height} px) of ${what}` +
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

/** `screencapture -x -t jpg [-R x,y,w,h] <path>`: silent, JPEG, primary display. */
export function screencaptureArgs(path: string, region?: ScreenRegion): string[] {
  const args = ["-x", "-t", "jpg"];
  if (region) {
    args.push("-R", [region.x, region.y, region.width, region.height].join(","));
  }
  args.push(path);
  return args;
}

/**
 * The region as the schema sends it: top-level `x`, `y`, `width`,
 * `height` (all four or none). `region: {…}` is still read for a model
 * that nests it. Strict mode sends an omitted one as `null`.
 */
function flatRegion(args: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = ["x", "y", "width", "height"] as const;
  if (keys.every((k) => args[k] === undefined || args[k] === null)) return undefined;
  return { x: args.x, y: args.y, width: args.width, height: args.height };
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
  env: NodeJS.ProcessEnv,
): Promise<{ width: number; height: number }> {
  const result = await deps.run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: 10_000,
    env,
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
