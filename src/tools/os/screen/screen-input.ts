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
  type ScreenApp,
  type ScreenDeps,
  type ScreenProbe,
} from "./screen-host.js";
import type { ScreenOp } from "./screen-jxa.js";
import { parseKeyChord } from "./screen-keys.js";
import {
  protectedAppReason,
  protectedBundleIds,
  refusedChordReason,
} from "./screen-protected.js";

export const OS_SCREEN_CLICK_TOOL = "os.screen.click";
export const OS_SCREEN_TYPE_TOOL = "os.screen.type";
export const OS_SCREEN_KEY_TOOL = "os.screen.key";

/** Longest text one `os.screen.type` call sends — and shows, in full, in its approval. */
export const SCREEN_TYPE_MAX_CHARS = 2_000;

const SCREEN_RESULT_OPTIONS = { maxSummaryLength: 1_200, maxTailLines: 40 } as const;

export interface OsScreenInputOptions extends DangerousToolOptions {
  deps: ScreenDeps;
  geometry: ScreenGeometryStore;
}

type Pin = { expectBundleId: string; protectedIds: readonly string[] };

/** What one input tool contributes to the shared probe → refuse/approve → act flow. */
interface PlannedAction {
  /** Click only: the point whose window owner receives the input. */
  point?: { x: number; y: number };
  /** Checks that need the probe (the click point must be on the display). */
  check?: (probe: ScreenProbe) => void;
  operation: (pin: Pin) => ScreenOp;
  /** `left click at 812,440` — the approval reason and the result's verb. */
  summary: string;
  /** Extra preview lines (the full text being typed, the mapping used). */
  preview: readonly string[];
  details: Record<string, unknown>;
}

type Planner = (args: Record<string, unknown>, ctx: ToolContext) => PlannedAction;

/**
 * Parse → probe → refuse or approve → act, shared by click / type / key.
 *
 * The target is the app that would receive the input: for a click the
 * owner of the topmost window under the point (it may be the Dock or a
 * background window, not the frontmost app), otherwise the frontmost
 * app. A protected target (`screen-protected.ts`: the agent's own
 * terminal or app, any terminal, settings, credentials) is refused at
 * every level without a prompt — typing a slash command into the
 * agent's own terminal would let it raise its approval level. Missing
 * Accessibility answers before anyone is asked. Otherwise the approval
 * names the target, and the action is pinned to it: the script brings
 * it back to the front if the approval UI took focus, re-checks the
 * click owner, and refuses rather than posting into anything else.
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
      let action: PlannedAction;
      let probe: ScreenProbe;
      try {
        action = plan(rawArgs, ctx);
        probe = await runScreenOp(deps, { op: "probe", ...(action.point ? { point: action.point } : {}) }, ctx);
        if (probe.accessibility === false) return permissionResult(name, deps);
        action.check?.(probe);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      const target = action.point ? (probe.ownerAtPoint ?? null) : probe.frontmost;
      const refusal = protectedAppReason(target?.bundleId, deps.env);
      if (refusal !== null || !target?.bundleId) {
        return refusedResult(name, `${action.summary} in ${describeApp(target)}`, refusal ?? "unknown target", action.details);
      }
      const app = describeApp(target);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: name,
          category: "screen_control",
          reason: `${action.summary} in ${app}`,
          preview: [`${name}: ${action.summary}`, `receives the input: ${app}`, ...action.preview].join("\n"),
          affectedResources: [`app:${target.bundleId}`],
        },
        ctx.signal,
      );
      const pin: Pin = { expectBundleId: target.bundleId, protectedIds: protectedBundleIds(deps.env) };
      let after: ScreenProbe;
      try {
        after = await runScreenOp(deps, action.operation(pin), ctx);
      } catch (error) {
        return result(name, "error", `${name}: ${(error as Error).message}`);
      }
      return actionResult(name, app, action, after, deps);
    },
  };
}

function actionResult(
  name: string,
  app: string,
  action: PlannedAction,
  after: ScreenProbe,
  deps: ScreenDeps,
): CompressedToolResult {
  const details = { ...action.details, frontmost: after.frontmost, ...(after.via ? { via: after.via } : {}) };
  switch (after.error) {
    case undefined:
      break;
    case "accessibility":
      return permissionResult(name, deps);
    case "protected":
      return refusedResult(name, action.summary, `the input would reach ${describeApp(after.ownerAtPoint ?? after.frontmost)}, a protected app`, details);
    case "not-frontmost":
      return result(name, "error", `${name} did nothing: ${app} could not be brought back to the front (now: ${describeApp(after.frontmost)}). Take a new os.screen.capture.`, { ...details, reason: "not-frontmost" });
    case "owner-mismatch":
      return result(name, "error", `${name} did nothing: the click would land on ${describeApp(after.ownerAtPoint ?? null)}, not the approved ${app}. Take a new os.screen.capture.`, { ...details, reason: "owner-mismatch" });
    default:
      return result(name, "error", `${name} did nothing: ${after.error}`, details);
  }
  if (!after.done) return result(name, "error", `${name} did nothing: the script reported no action`, details);
  return result(name, "ok", `${action.summary} in ${app}. Take os.screen.capture to see the result.`, details);
}

export function buildOsScreenClickTool(options: OsScreenInputOptions): ToolDefinition {
  return buildInputTool(
    OS_SCREEN_CLICK_TOOL,
    "Click on the primary display (macOS) at x,y in the pixels of the last os.screen.capture image. Asks the user first; never clicks into a terminal, the agent itself, settings or a password manager.",
    options,
    (args, ctx) => {
      const x = requireNumber(args.x, "x");
      const y = requireNumber(args.y, "y");
      const scale = args.scale === undefined ? undefined : requirePositive(args.scale, "scale");
      if (args.button !== undefined && args.button !== "left" && args.button !== "right") {
        throw new Error('`button` must be "left" or "right"');
      }
      const button: "left" | "right" = args.button === "right" ? "right" : "left";
      const double = args.double === true;
      const point = toScreenPoint(x, y, options.geometry.get(ctx.sessionId), scale);
      const verb = `${double ? "double " : ""}${button} click`;
      return {
        point: { x: point.x, y: point.y },
        check: (probe) => {
          if (point.x < 0 || point.y < 0 || point.x > probe.screen.width || point.y > probe.screen.height) {
            throw new Error(
              `x,y ${x},${y} map to screen point ${point.x},${point.y}, outside the primary display ` +
                `(${probe.screen.width}x${probe.screen.height} points); take a new os.screen.capture`,
            );
          }
        },
        operation: (pin) => ({ op: "click", x: point.x, y: point.y, button, double, ...pin }),
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
    "Type text into the focused field of the frontmost app (macOS), as keystrokes or (via: \"paste\") through the clipboard. Asks the user first, showing the whole text; never types into a terminal, the agent itself, settings or a password manager.",
    options,
    (args) => {
      const text = args.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("`text` must be a non-empty string");
      }
      if (text.length > SCREEN_TYPE_MAX_CHARS) {
        throw new Error(`\`text\` is ${text.length} characters; at most ${SCREEN_TYPE_MAX_CHARS} per call`);
      }
      if (args.via !== undefined && args.via !== "keys" && args.via !== "paste") {
        throw new Error('`via` must be "keys" or "paste"');
      }
      const typeVia: "keys" | "paste" = args.via === "paste" ? "paste" : "keys";
      return {
        operation: (pin) => ({ op: "type", text, typeVia, ...pin }),
        summary: `type ${JSON.stringify(text)}`,
        preview: [previewText(text), ...(typeVia === "paste" ? ["via the clipboard (restored afterwards)"] : [])],
        details: { chars: text.length, typeVia },
      };
    },
  );
}

export function buildOsScreenKeyTool(options: OsScreenInputOptions): ToolDefinition {
  return buildInputTool(
    OS_SCREEN_KEY_TOOL,
    'Press a key or shortcut in the frontmost app (macOS), e.g. "return", "escape", "down", "cmd+l". Asks the user first; app and space switchers (cmd+tab, ctrl+arrows, cmd+space) are refused.',
    options,
    (args) => {
      if (typeof args.keys !== "string") {
        throw new Error('`keys` must be a string such as "return" or "cmd+l"');
      }
      const chord = parseKeyChord(args.keys);
      const refused = refusedChordReason(chord);
      if (refused !== null) {
        throw new Error(`refused: ${refused}, which would move input to an app nobody approved; click the target instead`);
      }
      return {
        operation: (pin) => ({ op: "key", keyCode: chord.keyCode, flags: chord.flags, ...pin }),
        summary: `press ${chord.label}`,
        preview: [],
        details: { keys: chord.label, keyCode: chord.keyCode, flags: chord.flags },
      };
    },
  );
}

/**
 * The whole text, as a JSON string so line breaks and invisible
 * characters are visible. Never shortened or hidden: the user must see
 * exactly what goes where, a password included (the agent wrote it).
 */
export function previewText(text: string): string {
  return `text (${text.length} chars): ${JSON.stringify(text)}`;
}

function describeApp(app: ScreenApp | null | undefined): string {
  if (!app || (!app.name && !app.bundleId)) return "an unknown app";
  if (app.name && app.bundleId) return `${app.name} (${app.bundleId})`;
  return app.name ?? app.bundleId ?? "an unknown app";
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

function refusedResult(
  tool: string,
  what: string,
  why: string,
  details: Record<string, unknown>,
): CompressedToolResult {
  return result(
    tool,
    "error",
    `${tool} refused (${what}): ${why}. Screen control never sends input to a terminal, Atomic Agent itself, ` +
      "system settings, the keychain or a password manager, at any approval level. Do not try another way; " +
      "tell the user to do this step themselves.",
    { ...details, retryable: false, reason: "protected-app" },
  );
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
