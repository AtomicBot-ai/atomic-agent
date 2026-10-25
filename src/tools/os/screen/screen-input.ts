import {
  compressToolResult,
  type CompressedToolResult,
} from "../../../compressor/result-compressor.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";
import type { ToolContext, ToolDefinition } from "../../tool-registry.js";
import { toScreenPoint, type ScreenGeometryStore } from "./screen-geometry.js";
import {
  accessibilityMessage,
  macOnlyMessage,
  runScreenOp,
  type ScreenDeps,
  type ScreenProbe,
} from "./screen-host.js";
import type { ScreenOp } from "./screen-jxa.js";
import { parseKeyChord } from "./screen-keys.js";

export const OS_SCREEN_CLICK_TOOL = "os.screen.click";
export const OS_SCREEN_TYPE_TOOL = "os.screen.type";
export const OS_SCREEN_KEY_TOOL = "os.screen.key";

/** Longest text one `os.screen.type` call sends. */
export const SCREEN_TYPE_MAX_CHARS = 2_000;

const SCREEN_RESULT_OPTIONS = { maxSummaryLength: 1_200, maxTailLines: 40 } as const;

export interface OsScreenInputOptions extends DangerousToolOptions {
  deps: ScreenDeps;
  geometry: ScreenGeometryStore;
}

/** What one input tool contributes to the shared probe → approve → act flow. */
interface PlannedAction {
  /** The JXA operation, minus the frontmost-app pin the flow adds. */
  operation: (expectBundleId: string | null) => ScreenOp;
  /** `left click at 812,440` — the approval reason and the result's verb. */
  summary: string;
  /** Extra preview lines (the text being typed, the mapping used). */
  preview: readonly string[];
  details: Record<string, unknown>;
}

type Planner = (
  args: Record<string, unknown>,
  ctx: ToolContext,
  probe: ScreenProbe,
) => PlannedAction;

/**
 * Probe → approve → act, shared by click / type / key.
 *
 * The probe is read-only (permissions, frontmost app, screen size): a
 * missing Accessibility grant answers before anyone is asked to
 * approve a click that cannot happen, and the approval preview names
 * the app that will receive the input. The action run then refuses if
 * a different app has come to the front since — the operator approved
 * input for the app they were shown. A denial throws out of
 * `requireApproval`, so the action is never run.
 */
function buildInputTool(
  name: string,
  description: string,
  options: OsScreenInputOptions,
  plan: Planner,
): ToolDefinition {
  const { deps } = options;
  return {
    name,
    description,
    readonly: false,
    async run(rawArgs, ctx) {
      if (deps.platform !== "darwin") {
        return result(name, "error", macOnlyMessage(name, deps.platform));
      }
      let probe: ScreenProbe;
      let action: PlannedAction;
      try {
        probe = await runScreenOp(deps, { op: "probe" }, ctx);
        if (probe.accessibility === false) {
          return permissionResult(name, deps);
        }
        action = plan(rawArgs, ctx, probe);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      const app = describeApp(probe);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: name,
          category: "screen_control",
          reason: `${action.summary} in ${app}`,
          preview: [`${name}: ${action.summary}`, `frontmost app: ${app}`, ...action.preview].join("\n"),
          affectedResources: [`app:${probe.frontmost?.bundleId ?? "unknown"}`],
        },
        ctx.signal,
      );
      let after: ScreenProbe;
      try {
        after = await runScreenOp(deps, action.operation(probe.frontmost?.bundleId ?? null), ctx);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      if (after.error === "accessibility" || after.accessibility === false) {
        return permissionResult(name, deps);
      }
      if (after.error === "frontmost-changed") {
        return result(
          name,
          "error",
          `${name} did nothing: the frontmost app changed from ${app} to ${describeApp(after)} after approval. ` +
            "Take a new os.screen.capture and try again.",
          { ...action.details, reason: "frontmost-changed" },
        );
      }
      if (!after.done) {
        return result(name, "error", `${name} did nothing: ${after.error ?? "the script reported no action"}`);
      }
      return result(name, "ok", `${action.summary} in ${app}. Take os.screen.capture to see the result.`, {
        ...action.details,
        frontmost: after.frontmost,
      });
    },
  };
}

export function buildOsScreenClickTool(options: OsScreenInputOptions): ToolDefinition {
  return buildInputTool(
    OS_SCREEN_CLICK_TOOL,
    "Click on the screen (macOS) at x,y in the pixels of the last os.screen.capture image. Asks the user first.",
    options,
    (args, ctx, probe) => {
      const x = requireNumber(args.x, "x");
      const y = requireNumber(args.y, "y");
      const scale = args.scale === undefined ? undefined : requirePositive(args.scale, "scale");
      if (args.button !== undefined && args.button !== "left" && args.button !== "right") {
        throw new Error('`button` must be "left" or "right"');
      }
      const button: "left" | "right" = args.button === "right" ? "right" : "left";
      const double = args.double === true;
      const point = toScreenPoint(x, y, options.geometry.get(ctx.sessionId), scale);
      if (point.x < 0 || point.y < 0 || point.x > probe.screen.width || point.y > probe.screen.height) {
        throw new Error(
          `x,y ${x},${y} map to screen point ${point.x},${point.y}, outside the main screen ` +
            `(${probe.screen.width}x${probe.screen.height} points); take a new os.screen.capture`,
        );
      }
      const verb = `${double ? "double " : ""}${button} click`;
      return {
        operation: (expectBundleId) => ({ op: "click", x: point.x, y: point.y, button, double, expectBundleId }),
        summary: `${verb} at ${point.x},${point.y}`,
        preview: [`image px ${x},${y} at scale ${point.scale} → screen point ${point.x},${point.y}`],
        details: { x, y, screenX: point.x, screenY: point.y, scale: point.scale, button, double },
      };
    },
  );
}

export function buildOsScreenTypeTool(options: OsScreenInputOptions): ToolDefinition {
  return buildInputTool(
    OS_SCREEN_TYPE_TOOL,
    "Type text into the focused field of the frontmost app (macOS), as keystrokes. Asks the user first.",
    options,
    (args) => {
      const text = args.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("`text` must be a non-empty string");
      }
      if (text.length > SCREEN_TYPE_MAX_CHARS) {
        throw new Error(`\`text\` is ${text.length} characters; at most ${SCREEN_TYPE_MAX_CHARS} per call`);
      }
      return {
        operation: (expectBundleId) => ({ op: "type", text, expectBundleId }),
        summary: `type ${text.length} character${text.length === 1 ? "" : "s"}`,
        preview: [previewText(text)],
        details: { chars: text.length },
      };
    },
  );
}

export function buildOsScreenKeyTool(options: OsScreenInputOptions): ToolDefinition {
  return buildInputTool(
    OS_SCREEN_KEY_TOOL,
    'Press a key or shortcut in the frontmost app (macOS), e.g. "return", "escape", "down", "cmd+shift+t". Asks the user first.',
    options,
    (args) => {
      if (typeof args.keys !== "string") {
        throw new Error('`keys` must be a string such as "return" or "cmd+l"');
      }
      const chord = parseKeyChord(args.keys);
      return {
        operation: (expectBundleId) => ({ op: "key", keyCode: chord.keyCode, flags: chord.flags, expectBundleId }),
        summary: `press ${chord.label}`,
        preview: [],
        details: { keys: chord.label, keyCode: chord.keyCode, flags: chord.flags },
      };
    },
  );
}

const SECRET_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|AKIA|AIza|glpat-|npm_)/;

/** True for text shaped like a token or password, which a preview must not echo. */
export function looksLikeSecret(text: string): boolean {
  const trimmed = text.trim();
  if (SECRET_PREFIX.test(trimmed)) return true;
  if (/\s/.test(trimmed) || trimmed.length < 12) return false;
  return /[A-Za-z]/.test(trimmed) && /\d/.test(trimmed);
}

/** `text (42 chars): "Hello, wor…"` — or no content at all for a secret-looking string. */
export function previewText(text: string): string {
  if (looksLikeSecret(text)) {
    return `text: ${text.length} characters, not shown (looks like a password or token)`;
  }
  const head = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  return `text (${text.length} chars): ${JSON.stringify(head)}`;
}

function describeApp(probe: ScreenProbe): string {
  const front = probe.frontmost;
  if (!front || (!front.name && !front.bundleId)) return "an unknown app";
  if (front.name && front.bundleId) return `${front.name} (${front.bundleId})`;
  return front.name ?? front.bundleId ?? "an unknown app";
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`\`${field}\` must be a number >= 0`);
  }
  return value;
}

function requirePositive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`\`${field}\` must be a number > 0`);
  }
  return value;
}

function permissionResult(tool: string, deps: ScreenDeps): CompressedToolResult {
  return result(tool, "error", accessibilityMessage(deps.env), {
    retryable: false,
    reason: "accessibility-permission",
  });
}

function result(
  tool: string,
  status: "ok" | "error",
  output: string,
  details: Record<string, unknown> = {},
): CompressedToolResult {
  return compressToolResult({ tool, status, output, details }, SCREEN_RESULT_OPTIONS);
}
