/**
 * ATO-1018 "show where to click": the agent's `os.screen.point` marks,
 * drawn on the person's screen by a transparent, click-through overlay.
 *
 * The agent sends them on the chat stream's `tool_result` frame as
 * `screen_marks: {marks, seconds}`, in global screen points: origin at
 * the primary display's top-left, y down, the other displays at their
 * own offsets (negative ones included). That is the space Electron's
 * `screen` API reports in on macOS (DIP = points), so a mark is placed
 * by subtracting its display's origin, and a Retina display needs no
 * factor: the overlay's CSS pixels are points.
 *
 * This file holds no Electron: the planning (which display draws what,
 * where the arrow's tail goes) is pure, and `ScreenMarksOverlay` gets
 * its windows, timers, cursor and Esc key through `OverlayDeps`, so the
 * lifecycle is tested without a screen (test/screen-marks.test.mjs).
 * main.ts wires the real ones.
 *
 * The overlay never takes a click or the focus: its windows ignore the
 * mouse and cannot be focused. So "the person clicked the spot" cannot
 * be seen directly (that would need Input Monitoring); a mark is taken
 * as done when the pointer reaches its spot and then leaves it. Every
 * set also ends on Esc, on its timeout (capped at two minutes), on the
 * next turn, on a display change and on quit.
 */

export type MarkKind = "arrow" | "box" | "label";

export interface ScreenMark {
  kind: MarkKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  step?: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayInfo {
  id: number;
  bounds: Rect;
}

/** A mark in one overlay window's own coordinates. */
export interface LocalMark {
  /** Index in the set, so a reached mark can be taken out of every window. */
  index: number;
  kind: MarkKind;
  /** Arrow tip, box top-left or label anchor. */
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Arrow only: where its line starts. */
  tailX?: number;
  tailY?: number;
  text?: string;
  step?: number;
}

export const MAX_MARKS = 8;
export const MARK_TEXT_MAX = 60;
export const DEFAULT_SECONDS = 20;
/** However long the agent asked for, nothing stays past this. */
export const MAX_SECONDS = 120;
const MIN_SECONDS = 3;
const POINT_LIMIT = 100_000;
/** How far an arrow's tail sits from its tip, in points. */
export const ARROW_LENGTH = 96;
/** The pointer counts as on an arrow's spot within this many points of the tip. */
export const ARROW_REACH = 28;
/** And on a box's spot this far around its edges. */
export const BOX_REACH = 6;
/** How often the pointer is looked at while marks show. */
export const CURSOR_POLL_MS = 120;

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The frame's `screen_marks` as something safe to draw, or null. Same
 * rules as the agent's own parser: the overlay must not draw what the
 * agent would have refused, whatever sent the frame.
 */
export function parseScreenMarks(raw: unknown): { marks: ScreenMark[]; seconds: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { marks, seconds } = raw as { marks?: unknown; seconds?: unknown };
  if (!Array.isArray(marks) || marks.length === 0) return null;
  const out: ScreenMark[] = [];
  for (const item of marks.slice(0, MAX_MARKS)) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (m.kind !== "arrow" && m.kind !== "box" && m.kind !== "label") continue;
    if (!finite(m.x) || !finite(m.y) || Math.abs(m.x) > POINT_LIMIT || Math.abs(m.y) > POINT_LIMIT) continue;
    const mark: ScreenMark = { kind: m.kind, x: m.x, y: m.y };
    if (m.kind === "box") {
      if (!finite(m.width) || !finite(m.height) || m.width <= 0 || m.height <= 0) continue;
      if (m.width > POINT_LIMIT || m.height > POINT_LIMIT) continue;
      mark.width = m.width;
      mark.height = m.height;
    }
    if (typeof m.text === "string") {
      const text = m.text.replace(/\s+/g, " ").trim().slice(0, MARK_TEXT_MAX);
      if (text) mark.text = text;
    }
    if (m.kind === "label" && !mark.text) continue;
    if (Number.isInteger(m.step) && (m.step as number) >= 1 && (m.step as number) <= 99) mark.step = m.step as number;
    out.push(mark);
  }
  if (out.length === 0) return null;
  const secs = finite(seconds) ? seconds : DEFAULT_SECONDS;
  return { marks: out, seconds: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(secs))) };
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The display a point is on, or the nearest one when it is in a gap between them. */
export function displayFor(displays: readonly DisplayInfo[], x: number, y: number): DisplayInfo | null {
  let best: DisplayInfo | null = null;
  let bestDistance = Infinity;
  for (const d of displays) {
    if (contains(d.bounds, x, y)) return d;
    const dx = Math.max(d.bounds.x - x, 0, x - (d.bounds.x + d.bounds.width));
    const dy = Math.max(d.bounds.y - y, 0, y - (d.bounds.y + d.bounds.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Where an arrow's tail goes: toward the middle of the tip's display,
 * so the whole arrow lands on the screen the spot is on; from the
 * lower right when the tip is at the middle itself.
 */
export function arrowTail(tipX: number, tipY: number, display: Rect): { x: number; y: number } {
  const cx = display.x + display.width / 2;
  const cy = display.y + display.height / 2;
  let dx = cx - tipX;
  let dy = cy - tipY;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    dx = 1;
    dy = 1;
  }
  const scale = ARROW_LENGTH / Math.hypot(dx, dy);
  return { x: round1(tipX + dx * scale), y: round1(tipY + dy * scale) };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** The area a mark covers on the screen, in global points (arrow: tip and tail). */
function extent(mark: ScreenMark, tail?: { x: number; y: number }): Rect {
  if (mark.kind === "box") return { x: mark.x, y: mark.y, width: mark.width!, height: mark.height! };
  if (mark.kind === "arrow" && tail) {
    const x = Math.min(mark.x, tail.x);
    const y = Math.min(mark.y, tail.y);
    return { x, y, width: Math.abs(mark.x - tail.x) + 1, height: Math.abs(mark.y - tail.y) + 1 };
  }
  return { x: mark.x, y: mark.y, width: 1, height: 1 };
}

/**
 * Which display draws which marks, in that display's window coordinates.
 * A mark goes to every display it touches (a box across two screens is
 * drawn on both, each half where it is); a mark off every display goes
 * to the nearest one, so the person still sees where the agent meant.
 * Only displays with something to draw are in the plan.
 */
export function planOverlay(
  marks: readonly ScreenMark[],
  displays: readonly DisplayInfo[],
): Map<number, { display: DisplayInfo; marks: LocalMark[] }> {
  const plan = new Map<number, { display: DisplayInfo; marks: LocalMark[] }>();
  marks.forEach((mark, index) => {
    const home = displayFor(displays, mark.x, mark.y);
    if (!home) return;
    const tail = mark.kind === "arrow" ? arrowTail(mark.x, mark.y, home.bounds) : undefined;
    const area = extent(mark, tail);
    const targets = displays.filter((d) => intersects(d.bounds, area));
    for (const d of targets.length > 0 ? targets : [home]) {
      const ox = d.bounds.x;
      const oy = d.bounds.y;
      const local: LocalMark = { index, kind: mark.kind, x: round1(mark.x - ox), y: round1(mark.y - oy) };
      if (mark.width !== undefined) local.width = mark.width;
      if (mark.height !== undefined) local.height = mark.height;
      if (tail) {
        local.tailX = round1(tail.x - ox);
        local.tailY = round1(tail.y - oy);
      }
      if (mark.text !== undefined) local.text = mark.text;
      if (mark.step !== undefined) local.step = mark.step;
      const entry = plan.get(d.id) ?? { display: d, marks: [] };
      entry.marks.push(local);
      plan.set(d.id, entry);
    }
  });
  return plan;
}

/** The spot a person reaches for: around an arrow's tip or a box. Labels have none. */
export function markTarget(mark: ScreenMark): Rect | null {
  if (mark.kind === "arrow") {
    return { x: mark.x - ARROW_REACH, y: mark.y - ARROW_REACH, width: ARROW_REACH * 2, height: ARROW_REACH * 2 };
  }
  if (mark.kind === "box") {
    return {
      x: mark.x - BOX_REACH,
      y: mark.y - BOX_REACH,
      width: mark.width! + BOX_REACH * 2,
      height: mark.height! + BOX_REACH * 2,
    };
  }
  return null;
}

export interface OverlayWindow {
  draw(marks: LocalMark[]): void;
  close(): void;
}

export interface OverlayDeps {
  displays(): DisplayInfo[];
  /** A click-through, unfocusable, always-on-top window covering `display`. */
  openWindow(display: DisplayInfo): OverlayWindow;
  cursor(): { x: number; y: number };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Take Esc while marks show; false when it could not be taken. */
  grabEscape(onEscape: () => void): boolean;
  releaseEscape(): void;
  log?(line: string): void;
}

export type ClearReason = "timeout" | "escape" | "reached" | "next-turn" | "replaced" | "displays" | "quit";

export class ScreenMarksOverlay {
  private marks: ScreenMark[] = [];
  private live = new Set<number>();
  private windows = new Map<number, OverlayWindow>();
  private timer: unknown = null;
  private poll: unknown = null;
  private escape = false;
  /** The mark whose spot the pointer is on, if any. */
  private onSpot: number | null = null;

  constructor(private readonly deps: OverlayDeps) {}

  get showing(): boolean {
    return this.windows.size > 0;
  }

  /** Draw a set, replacing the one on screen. Returns how many marks are drawn. */
  show(raw: unknown): number {
    const parsed = parseScreenMarks(raw);
    if (this.showing) this.clear("replaced");
    if (!parsed) return 0;
    const displays = this.deps.displays();
    const plan = planOverlay(parsed.marks, displays);
    if (plan.size === 0) return 0;
    this.marks = parsed.marks;
    this.live = new Set(parsed.marks.map((_, i) => i));
    for (const [id, entry] of plan) {
      try {
        const win = this.deps.openWindow(entry.display);
        this.windows.set(id, win);
        win.draw(entry.marks);
      } catch (err) {
        this.deps.log?.(`[screen-marks] overlay for display ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!this.showing) return 0;
    this.timer = this.deps.setTimeout(() => this.clear("timeout"), parsed.seconds * 1000);
    if (parsed.marks.some((m) => markTarget(m) !== null)) {
      this.poll = this.deps.setInterval(() => this.watchPointer(), CURSOR_POLL_MS);
    }
    this.escape = this.deps.grabEscape(() => this.clear("escape"));
    return parsed.marks.length;
  }

  clear(reason: ClearReason): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    if (this.poll !== null) this.deps.clearInterval(this.poll);
    this.timer = null;
    this.poll = null;
    if (this.escape) this.deps.releaseEscape();
    this.escape = false;
    const had = this.windows.size > 0;
    for (const win of this.windows.values()) {
      try {
        win.close();
      } catch {
        /* already gone */
      }
    }
    this.windows.clear();
    this.marks = [];
    this.live.clear();
    this.onSpot = null;
    if (had) this.deps.log?.(`[screen-marks] cleared (${reason})`);
  }

  /**
   * A chat event from AgentClient: an `os.screen.point` result draws its
   * marks; the first frame of any new turn (`session_id`) clears them.
   */
  observe(event: { kind?: unknown; payload?: unknown }): void {
    const payload = (event.payload ?? {}) as { tool?: unknown; status?: unknown; screen_marks?: unknown };
    if (event.kind === "session_id") {
      if (this.showing) this.clear("next-turn");
      return;
    }
    if (event.kind === "tool_result" && payload.tool === "os.screen.point" && payload.status === "ok" && payload.screen_marks) {
      this.show(payload.screen_marks);
    }
  }

  /**
   * The pointer reached a mark's spot and left it: the person found it
   * (and most likely clicked it). That mark goes; when no mark with a
   * spot is left, the labels go with them.
   */
  private watchPointer(): void {
    let at: { x: number; y: number };
    try {
      at = this.deps.cursor();
    } catch {
      return;
    }
    const inside = [...this.live].find((i) => {
      const target = markTarget(this.marks[i]!);
      return target !== null && contains(target, at.x, at.y);
    });
    if (inside !== undefined) {
      this.onSpot = inside;
      return;
    }
    if (this.onSpot === null) return;
    const done = this.onSpot;
    this.onSpot = null;
    this.live.delete(done);
    if (![...this.live].some((i) => markTarget(this.marks[i]!) !== null)) {
      this.clear("reached");
      return;
    }
    this.redraw();
  }

  private redraw(): void {
    const kept = [...this.live].sort((a, b) => a - b);
    const plan = planOverlay(kept.map((i) => this.marks[i]!), this.deps.displays());
    for (const [id, win] of this.windows) {
      const entry = plan.get(id);
      // Indexes are the set's, not the kept list's.
      win.draw((entry?.marks ?? []).map((m) => ({ ...m, index: kept[m.index]! })));
    }
  }
}
