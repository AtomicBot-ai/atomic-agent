import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { toScreenPoint, type CaptureGeometry, type ScreenGeometryStore } from "./screen-geometry.js";
import { macOnlyMessage } from "./screen-host.js";
import { screenOverlayAvailable } from "./screen-overlay-hosts.js";

export const OS_SCREEN_POINT_TOOL = "os.screen.point";

export type ScreenMarkKind = "arrow" | "box" | "label";

/**
 * One mark, in global screen points (the space macOS clicks in and
 * Electron's `screen` API uses: origin at the primary display's
 * top-left, y down, other displays at their own offsets, negative ones
 * included). `x, y` is the arrow's tip, the box's top-left corner or
 * the label's anchor.
 */
export interface ScreenMark {
  kind: ScreenMarkKind;
  x: number;
  y: number;
  /** Box only. */
  width?: number;
  height?: number;
  /** A short caption; required for a label. */
  text?: string;
  /** The step number drawn in a badge (1, 2, 3…). */
  step?: number;
}

/** What the host overlay receives (the `screen_marks` frame). */
export interface ScreenMarksPayload {
  marks: ScreenMark[];
  /** How long the overlay keeps them, at most; a click on the spot or Esc ends it sooner. */
  seconds: number;
}

export const SCREEN_POINT_MAX_MARKS = 8;
export const SCREEN_MARK_TEXT_MAX = 60;
export const SCREEN_POINT_DEFAULT_SECONDS = 20;
export const SCREEN_POINT_MAX_SECONDS = 120;
const SCREEN_POINT_MIN_SECONDS = 3;

/** Beyond any real arrangement of displays: a value out here is a bug, not a monitor. */
const POINT_LIMIT = 100_000;

const KINDS: readonly ScreenMarkKind[] = ["arrow", "box", "label"];

/**
 * Argument keys that would make this a click or a keystroke. The tool
 * only draws: these are refused by name, so a model that reaches for
 * them learns where input lives instead of getting a mark it took for
 * a click.
 */
const INPUT_KEYS = ["click", "double", "button", "type", "keys", "key", "press", "action"] as const;

const RESULT_OPTIONS = { maxSummaryLength: 1_200, maxTailLines: 40 } as const;

export interface OsScreenPointOptions {
  geometry: ScreenGeometryStore;
  platform: NodeJS.Platform;
  /** Test seam; the HTTP chat stream's claim (`screen-overlay-hosts.ts`) by default. */
  overlayAvailable?: (sessionId: string) => boolean;
}

/**
 * `os.screen.point { marks, coords?, seconds? }` (ATO-1018) — show the
 * user where to click: arrows, boxes and short labels, optionally
 * numbered, drawn by the desktop app's click-through overlay. It never
 * moves the mouse, clicks or types, asks nothing and needs no Screen
 * Recording of its own (only the `os.screen.capture` it reads its
 * pixels from does). Without a host that draws (the TUI, a channel, a
 * remote desktop) it says so and asks for words instead.
 *
 * `coords: "image"` (default) reads `x, y, width, height` as pixels of
 * this session's last capture, mapped like a click; `"points"` reads
 * them as global screen points (an accessibility frame, any display).
 * The marks travel on the result's `details.screenMarks`; the HTTP
 * stream lifts them into the `tool_result` frame.
 */
export function buildOsScreenPointTool(options: OsScreenPointOptions): ToolDefinition {
  const overlayAvailable = options.overlayAvailable ?? screenOverlayAvailable;
  return {
    name: OS_SCREEN_POINT_TOOL,
    description:
      "Show the user where to click: draw arrows, boxes or short labels (optionally numbered steps) on their screen through the desktop app. Coordinates are the pixels of the last os.screen.capture image, or global screen points with coords \"points\". Only draws: never clicks, types or moves the mouse.",
    readonly: true,
    async run(rawArgs, ctx) {
      if (options.platform !== "darwin") {
        return errorResult(macOnlyMessage(OS_SCREEN_POINT_TOOL, options.platform));
      }
      const input = INPUT_KEYS.find((key) => rawArgs[key] !== undefined && rawArgs[key] !== null);
      if (input !== undefined) {
        return errorResult(inputRefusal(input), { reason: "input-refused", refusedKey: input });
      }
      if (!overlayAvailable(ctx.sessionId)) {
        return errorResult(NO_OVERLAY_MESSAGE, { retryable: false, reason: "no-overlay" });
      }
      let payload: ScreenMarksPayload;
      let coords: "image" | "points";
      try {
        coords = parseCoords(rawArgs.coords);
        const last = options.geometry.get(ctx.sessionId);
        if (coords === "image" && last === undefined) {
          throw new Error(
            'no os.screen.capture in this session to read pixels from: take one first, or pass coords "points" with global screen points',
          );
        }
        payload = {
          marks: parseMarks(rawArgs.marks).map((mark) => (coords === "image" ? toPointsMark(mark, last!) : mark)),
          seconds: parseSeconds(rawArgs.seconds),
        };
      } catch (error) {
        return errorResult(`${OS_SCREEN_POINT_TOOL}: ${(error as Error).message}`);
      }
      return compressToolResult(
        {
          tool: OS_SCREEN_POINT_TOOL,
          status: "ok",
          output: describeShown(payload),
          details: { screenMarks: payload, coords },
        },
        RESULT_OPTIONS,
      );
    },
  };
}

export const NO_OVERLAY_MESSAGE =
  "Marks on the screen need the Atomic Agent desktop app on this Mac, and this chat is not in it (a terminal, a channel or a desktop connected to another computer). Nothing was drawn: describe the place in words instead (which app, which part of the window, the button's label).";

function inputRefusal(key: string): string {
  return (
    `${OS_SCREEN_POINT_TOOL} only draws marks; it never clicks, types or presses keys (refused \`${key}\`). ` +
    "Tell the user what to click, or use os.screen.click / os.screen.type / os.screen.key when screen control is turned on (tools.screen.enabled)."
  );
}

function describeShown(payload: ScreenMarksPayload): string {
  const lines = payload.marks.map((mark, index) => {
    const label = mark.step === undefined ? `${index + 1}.` : `step ${mark.step}:`;
    const size = mark.kind === "box" ? ` ${mark.width}x${mark.height}` : "";
    const text = mark.text ? ` "${mark.text}"` : "";
    return `${label} ${mark.kind} at ${mark.x},${mark.y}${size}${text}`;
  });
  return [
    `Showing ${payload.marks.length} mark${payload.marks.length === 1 ? "" : "s"} on the user's screen (screen points) for up to ${payload.seconds} s:`,
    ...lines,
    "They go away when the user clicks there, presses Esc or sends the next message. Nothing was clicked or typed: tell the user in words what to do with the marked spot.",
  ].join("\n");
}

function parseCoords(raw: unknown): "image" | "points" {
  if (raw === undefined || raw === null) return "image";
  if (raw === "image" || raw === "points") return raw;
  throw new Error('`coords` must be "image" (pixels of the last os.screen.capture) or "points" (global screen points)');
}

function parseSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) return SCREEN_POINT_DEFAULT_SECONDS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error("`seconds` must be a number");
  return Math.min(SCREEN_POINT_MAX_SECONDS, Math.max(SCREEN_POINT_MIN_SECONDS, Math.round(raw)));
}

export function parseMarks(raw: unknown): ScreenMark[] {
  // A single mark sent bare is read as a list of one.
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? [raw] : null;
  if (list === null || list.length === 0) {
    throw new Error('`marks` needs at least one { kind: "arrow"|"box"|"label", x, y, … }');
  }
  if (list.length > SCREEN_POINT_MAX_MARKS) {
    throw new Error(`at most ${SCREEN_POINT_MAX_MARKS} marks at once (got ${list.length}); show the first steps, then the rest`);
  }
  return list.map((item, index) => parseMark(item, index));
}

function parseMark(raw: unknown, index: number): ScreenMark {
  const where = `marks[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object { kind, x, y, … }`);
  }
  const r = raw as Record<string, unknown>;
  const input = INPUT_KEYS.find((key) => r[key] !== undefined && r[key] !== null && key !== "type");
  if (input !== undefined) throw new Error(inputRefusal(input));
  const kind = (r.kind ?? r.type ?? "arrow") as ScreenMarkKind;
  if (!KINDS.includes(kind)) throw new Error(`${where}.kind must be "arrow", "box" or "label"`);
  const x = coordinate(r.x, `${where}.x`);
  const y = coordinate(r.y, `${where}.y`);
  const mark: ScreenMark = { kind, x, y };
  if (kind === "box") {
    mark.width = size(r.width, `${where}.width`);
    mark.height = size(r.height, `${where}.height`);
  }
  const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
  if (r.text !== undefined && r.text !== null && typeof r.text !== "string") {
    throw new Error(`${where}.text must be a string`);
  }
  if (text.length > SCREEN_MARK_TEXT_MAX) {
    throw new Error(`${where}.text is ${text.length} characters; keep a mark's text to ${SCREEN_MARK_TEXT_MAX} and say the rest in the reply`);
  }
  if (kind === "label" && text === "") throw new Error(`${where}: a label needs \`text\``);
  if (text !== "") mark.text = text;
  if (r.step !== undefined && r.step !== null) {
    if (typeof r.step !== "number" || !Number.isInteger(r.step) || r.step < 1 || r.step > 99) {
      throw new Error(`${where}.step must be a whole number from 1 to 99`);
    }
    mark.step = r.step;
  }
  return mark;
}

function coordinate(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) throw new Error(`${name} must be a number`);
  if (Math.abs(raw) > POINT_LIMIT) throw new Error(`${name} ${raw} is off every screen`);
  return raw;
}

function size(raw: unknown, name: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${name} must be a number above 0 (a box needs width and height)`);
  }
  if (raw > POINT_LIMIT) throw new Error(`${name} ${raw} is larger than any screen`);
  return raw;
}

/**
 * A mark given in the pixels of the last capture, in global screen
 * points: the same mapping a click uses (`toScreenPoint`), sizes divided
 * by the capture's scale. A pixel outside the image is refused: the
 * model is pointing at something it did not see.
 */
export function toPointsMark(mark: ScreenMark, last: CaptureGeometry): ScreenMark {
  const slack = 2;
  const outside = (x: number, y: number) =>
    x < -slack || y < -slack || x > last.imageWidth + slack || y > last.imageHeight + slack;
  const right = mark.x + (mark.width ?? 0);
  const bottom = mark.y + (mark.height ?? 0);
  if (outside(mark.x, mark.y) || outside(right, bottom)) {
    throw new Error(
      `${mark.kind} at ${mark.x},${mark.y} is outside the last capture (${last.imageWidth}x${last.imageHeight} px); use that image's pixels`,
    );
  }
  const at = toScreenPoint(mark.x, mark.y, last);
  const out: ScreenMark = { ...mark, x: at.x, y: at.y };
  if (mark.width !== undefined) out.width = round1(mark.width / at.scale);
  if (mark.height !== undefined) out.height = round1(mark.height / at.scale);
  return out;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function errorResult(message: string, details: Record<string, unknown> = {}) {
  return compressToolResult(
    { tool: OS_SCREEN_POINT_TOOL, status: "error", output: message, details },
    RESULT_OPTIONS,
  );
}
