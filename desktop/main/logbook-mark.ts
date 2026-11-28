/**
 * ATO-2534: the pure half of the logbook's `● Logbook` chip and menu bar
 * icon (logbook-ipc.ts, logbook-tray.ts, renderer/logbook-chip.js). No
 * Electron here, so test/logbook-mark.test.mjs runs it as built.
 *
 * The runtime behind `atomic-agent serve` captures only while this app
 * says its mark is on screen (src/logbook/logbook-indicator.ts): main
 * posts `POST /api/logbook/indicator {visible:true}` every MARK_EVERY_MS
 * while the chip is shown in a visible window or the menu bar icon is
 * up, and `{visible:false}` once when neither is. A report holds 45 s on
 * the runtime's side, so a crashed window stops the capture by itself.
 */

export type LogbookState = "off" | "on" | "paused";

/** What the chip, the menu and the menu bar icon draw, from GET /api/logbook. */
export interface LogbookChipView {
  state: LogbookState;
  pausedUntil: number | null;
  intervalMinutes: number;
  notesToday: number;
  lastOutcome: string | null;
  lastReason: string | null;
  supported: boolean;
  reason: string | null;
}

/** How often main asks the runtime for the state. */
export const POLL_EVERY_MS = 10_000;
/** How often main repeats a visible mark (the runtime keeps one for 45 s). */
export const MARK_EVERY_MS = 15_000;
/** The window repeats its chip report every 15 s; an older one no longer counts. */
export const CHIP_REPORT_FRESH_MS = 40_000;

const STATES: readonly string[] = ["off", "on", "paused"];

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** GET /api/logbook's answer, or null for anything else. */
export function parseLogbookView(raw: unknown): LogbookChipView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== "string" || !STATES.includes(o.state)) return null;
  const settings = (o.settings && typeof o.settings === "object" ? o.settings : {}) as Record<string, unknown>;
  const last = (o.last && typeof o.last === "object" ? o.last : {}) as Record<string, unknown>;
  const platform = (o.platform && typeof o.platform === "object" ? o.platform : {}) as Record<string, unknown>;
  return {
    state: o.state as LogbookState,
    pausedUntil: num(settings.pausedUntil),
    intervalMinutes: num(settings.intervalMinutes) ?? 5,
    notesToday: num(o.notesToday) ?? 0,
    lastOutcome: str(last.lastOutcome),
    lastReason: str(last.lastReason),
    supported: platform.supported !== false,
    reason: str(platform.reason),
  };
}

/** Whether this app's mark is on screen right now. */
export function markVisible(input: { chipVisible: boolean; chipReportedAt: number; trayShown: boolean; now: number }): boolean {
  if (input.trayShown) return true;
  return input.chipVisible && input.now - input.chipReportedAt <= CHIP_REPORT_FRESH_MS;
}

export interface MarkBody {
  visible: boolean;
  away?: boolean;
}

/**
 * Decides what to post each beat: `{visible:true, away}` on every beat
 * while the logbook is on (or paused, so a Resume captures at once) and
 * the mark is shown; `{visible:false}` once when that stops; nothing else.
 */
export function createMarkReporter(post: (body: MarkBody) => Promise<unknown>): {
  beat: (input: { state: LogbookState | null; visible: boolean; away: boolean }) => Promise<MarkBody | null>;
  posted: () => boolean;
} {
  let shown = false;
  return {
    beat: async ({ state, visible, away }) => {
      const want = visible && (state === "on" || state === "paused");
      if (!want && !shown) return null;
      const body: MarkBody = want ? { visible: true, away } : { visible: false };
      shown = want;
      try {
        await post(body);
      } catch {
        // The runtime is down or restarting; the next beat tries again.
        if (!want) shown = true;
      }
      return body;
    },
    posted: () => shown,
  };
}

export type LogbookAction = "pause" | "resume" | "stop";

/** The body for PATCH /api/logbook/settings from a click, or null. */
export function logbookActionBody(action: unknown, minutes?: unknown): { action: LogbookAction; minutes?: number } | null {
  if (action === "resume" || action === "stop") return { action };
  if (action !== "pause") return null;
  if (minutes === undefined) return { action };
  return typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? { action, minutes } : null;
}

/** A failed call in plain words; the runtime's own sentence for a refused action. */
export function logbookErrorText(status: number, body: unknown): string {
  const err = body && typeof body === "object" ? (body as { error?: { message?: unknown; code?: unknown } }).error : undefined;
  if (status === 409 && err && typeof err.message === "string") return err.message;
  if (status === 404) return "This version of the agent has no logbook controls. Update Atomic Agent to use them.";
  if (status === 403) return "The logbook can be changed only on the computer it runs on.";
  return "Atomic Agent did not answer. Try again in a moment.";
}

/** "until 14:30" for a pause, in the person's clock. */
export function pausedUntilText(until: number | null): string {
  if (until === null) return "";
  const d = new Date(until);
  return `until ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one-line state for the menu and the icon's tooltip. */
export function logbookStateLine(view: LogbookChipView): string {
  if (view.state === "paused") return `Logbook paused ${pausedUntilText(view.pausedUntil)}`.trim();
  if (view.state === "off") return "Logbook is off";
  const notes = view.notesToday === 1 ? "1 note today" : `${view.notesToday} notes today`;
  return `Logbook is on: a note every ${view.intervalMinutes} min, ${notes}`;
}

export type TrayItem =
  | { kind: "label"; label: string }
  | { kind: "action"; label: string; action: LogbookAction; minutes?: number }
  | { kind: "open"; label: string; target: "window" | "timeline" }
  | { kind: "separator" };

/** The menu bar icon's menu, and the same choices as the chip's menu. */
export function logbookTrayItems(view: LogbookChipView, opts: { timeline?: boolean } = {}): TrayItem[] {
  const items: TrayItem[] = [{ kind: "label", label: logbookStateLine(view) }, { kind: "separator" }];
  if (view.state === "paused") items.push({ kind: "action", label: "Resume", action: "resume" });
  else {
    items.push({ kind: "action", label: "Pause for 30 minutes", action: "pause", minutes: 30 });
    items.push({ kind: "action", label: "Pause for 1 hour", action: "pause", minutes: 60 });
  }
  items.push({ kind: "action", label: "Stop the logbook", action: "stop" });
  items.push({ kind: "separator" });
  if (opts.timeline) items.push({ kind: "open", label: "Open the timeline", target: "timeline" });
  items.push({ kind: "open", label: "Open Atomic Agent", target: "window" });
  return items;
}
