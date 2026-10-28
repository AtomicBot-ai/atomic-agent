import type { ToolRegistry } from "../../tool-registry.js";
import type { DangerousToolOptions } from "../../../approval/dangerous-tool.js";
import { buildOsScreenCaptureTool } from "./screen-capture.js";
import {
  buildOsScreenClickTool,
  buildOsScreenKeyTool,
  buildOsScreenTypeTool,
} from "./screen-input.js";
import { ScreenGeometryStore } from "./screen-geometry.js";
import { buildOsScreenPointTool } from "./screen-point.js";
import { resolveScreenDeps, type ScreenDeps } from "./screen-host.js";

export {
  buildOsScreenCaptureTool,
  OS_SCREEN_CAPTURE_TOOL,
  SCREENSHOT_DIR,
  parseRegion,
  screencaptureArgs,
  screenshotDir,
} from "./screen-capture.js";
export type { OsScreenCaptureOptions, ScreenRegion } from "./screen-capture.js";
export {
  buildOsScreenClickTool,
  buildOsScreenKeyTool,
  buildOsScreenTypeTool,
  OS_SCREEN_CLICK_TOOL,
  OS_SCREEN_KEY_TOOL,
  OS_SCREEN_TYPE_TOOL,
  previewText,
  SCREEN_TYPE_MAX_CHARS,
} from "./screen-input.js";
export type { OsScreenInputOptions } from "./screen-input.js";
export {
  captureGeometry,
  fitWithin,
  ScreenGeometryStore,
  SCREENSHOT_MAX_SIDE,
  toScreenPoint,
} from "./screen-geometry.js";
export type { CaptureGeometry } from "./screen-geometry.js";
export { parseKeyChord } from "./screen-keys.js";
export type { KeyChord } from "./screen-keys.js";
export {
  accessibilityMessage,
  hostAppName,
  parseScreenProbe,
  resolveScreenDeps,
  screenRecordingMessage,
} from "./screen-host.js";
export type {
  ScreenApp,
  ScreenCommandResult,
  ScreenDeps,
  ScreenProbe,
  ScreenRunner,
} from "./screen-host.js";
export { buildScreenInvocation, SCREEN_PAYLOAD_ENV, screenChildEnv } from "./screen-jxa.js";
export {
  BLOCKED_BUNDLE_IDS,
  BROWSER_BUNDLE_IDS,
  hostBundleIds,
  protectedAppReason,
  protectedBundleIds,
  refusedChordReason,
  screenAppClass,
  TERMINAL_BUNDLE_IDS,
} from "./screen-protected.js";
export type { ScreenAppClass, ScreenInputKind } from "./screen-protected.js";
export type { ScreenOp } from "./screen-jxa.js";
export {
  buildOsScreenPointTool,
  NO_OVERLAY_MESSAGE,
  OS_SCREEN_POINT_TOOL,
  parseMarks,
  SCREEN_POINT_DEFAULT_SECONDS,
  SCREEN_POINT_MAX_MARKS,
  SCREEN_POINT_MAX_SECONDS,
  toPointsMark,
} from "./screen-point.js";
export type { OsScreenPointOptions, ScreenMark, ScreenMarkKind, ScreenMarksPayload } from "./screen-point.js";
export { claimScreenOverlay, screenOverlayAvailable } from "./screen-overlay-hosts.js";

/** The five names, in catalog order — mirrored by `GATED_TOOLS.screen`. */
export const OS_SCREEN_TOOL_NAMES = [
  "os.screen.capture",
  "os.screen.click",
  "os.screen.type",
  "os.screen.key",
  "os.screen.point",
] as const;

export interface RegisterOsScreenToolsOptions extends DangerousToolOptions {
  /** `tools.screen.enabled` — mouse and keyboard control is opt-in, default off. */
  enabled: boolean;
  /**
   * `tools.screen.point` (ATO-1018, default on): `os.screen.point` draws
   * marks and nothing else, and `os.screen.capture` comes with it so the
   * model can see what it points at, without `enabled`.
   */
  point?: boolean;
  /** Host platform; the tools exist on macOS only (other OSes: ATO-527). */
  platform?: NodeJS.Platform;
  /** Test seam: runner, clock and file helpers. */
  deps?: Partial<ScreenDeps>;
}

/**
 * Register `os.screen.{capture,click,type,key}` when the operator turned
 * them on and the host is macOS, and `os.screen.{capture,point}` when
 * pointing is on; otherwise register nothing (the descriptor gate drops
 * them from the prompt the same way). They share one geometry store, so
 * a click or a mark maps the pixels of the capture the same session
 * took last.
 */
export function registerOsScreenTools(
  registry: ToolRegistry,
  options: RegisterOsScreenToolsOptions,
): void {
  const point = options.point === true;
  if (!options.enabled && !point) return;
  const deps = resolveScreenDeps({
    ...options.deps,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  if (deps.platform !== "darwin") return;
  const geometry = new ScreenGeometryStore();
  const input = {
    approvals: options.approvals,
    approvalRequired: options.approvalRequired,
    deps,
    geometry,
  };
  registry.register(buildOsScreenCaptureTool(input));
  if (options.enabled) {
    registry.register(buildOsScreenClickTool(input));
    registry.register(buildOsScreenTypeTool(input));
    registry.register(buildOsScreenKeyTool(input));
  }
  if (point) registry.register(buildOsScreenPointTool({ geometry, platform: deps.platform }));
}
