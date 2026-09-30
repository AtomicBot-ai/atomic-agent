/**
 * End-of-turn notification — the desktop half of the TUI's `tui.notify`
 * (config v71, src/tui/terminal-notify.ts).
 *
 * The TUI rings the terminal and raises an OS notification when a turn
 * ends, so an operator who walked away finds out without watching. The
 * desktop does the same with Electron's native Notification, and only
 * while the window is not focused: someone looking at the chat already
 * sees the turn end.
 *
 * Same key, same rules. `tui.notify.enabled` switches it; a failure always
 * notifies; a turn that finished only when it ran at least
 * `tui.notify.minDurationMs`, so a quick question does not ring every
 * time. The config is read when a turn ends (not cached), so the Settings
 * toggle and a hand edit both take effect on the next turn.
 */

export type TurnOutcome = "completed" | "failed" | "cancelled";

export interface NotifyConfig {
  enabled: boolean;
  minDurationMs: number;
}

/** USER_CONFIG_DEFAULTS.tui.notify — used when the key cannot be read. */
export const NOTIFY_DEFAULTS: NotifyConfig = { enabled: true, minDurationMs: 30_000 };

export interface TurnNotification {
  title: string;
  body: string;
}

/** Coerce whatever `atag config get tui.notify` printed into the two fields. */
export function readNotifyConfig(raw: unknown): NotifyConfig {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : NOTIFY_DEFAULTS.enabled,
    minDurationMs:
      typeof o.minDurationMs === "number" && Number.isFinite(o.minDurationMs) && o.minDurationMs >= 0
        ? o.minDurationMs
        : NOTIFY_DEFAULTS.minDurationMs,
  };
}

/** terminal-notify.ts shouldNotify: a failure always, a finish only when it ran long. */
export function shouldNotify(outcome: TurnOutcome, durationMs: number, cfg: NotifyConfig): boolean {
  if (!cfg.enabled) return false;
  if (outcome === "failed") return true;
  return durationMs >= cfg.minDurationMs;
}

function took(durationMs: number): string {
  const s = Math.max(0, Math.round(durationMs / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Control characters out, one line, clipped — the body is partly agent text. */
export function cleanNotificationText(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 32 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** terminal-notify.ts formatTurnNotification, in the desktop's words. */
export function formatTurnNotification(p: {
  outcome: TurnOutcome;
  steps: number;
  durationMs: number;
  error?: string | null;
  workingDirName?: string | undefined;
}): TurnNotification {
  const title = p.outcome === "failed" ? "Turn failed" : p.outcome === "cancelled" ? "Turn stopped" : "Turn done";
  const parts: string[] = [];
  if (p.outcome === "failed" && p.error) parts.push(p.error);
  if (p.steps > 0) parts.push(`${p.steps} tool call${p.steps === 1 ? "" : "s"}`);
  parts.push(took(p.durationMs));
  if (p.workingDirName) parts.push(p.workingDirName);
  return { title, body: cleanNotificationText(parts.join(" · ")) };
}

interface TurnTrack {
  startedAt: number;
  steps: number;
  /** An `event: error` frame, held until `done` says whether the turn went on after it. */
  heldError: string | null;
  workAfterError: boolean;
}

export interface TurnNotifierDeps {
  now?: () => number;
  /** True while the user is looking at the window. */
  isFocused: () => boolean;
  /** `tui.notify` as the config file has it now. */
  readConfig: () => Promise<NotifyConfig>;
  workingDirName: () => string | undefined;
  show: (note: TurnNotification) => void;
}

/**
 * Watches the `chat` events AgentClient emits and decides, per turn, whether
 * its ending deserves a notification. The error bookkeeping mirrors the
 * renderer's: a named error frame is followed by `done` in the same stream,
 * and only counts as the turn failing when no work came after it.
 */
export class TurnNotifier {
  private readonly turns = new Map<string, TurnTrack>();

  constructor(private readonly deps: TurnNotifierDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The turn was sent. Called by the chat IPC so the clock starts at the request. */
  begin(turnId: string): void {
    this.turns.set(turnId, { startedAt: this.now(), steps: 0, heldError: null, workAfterError: false });
  }

  observe(ev: { turnId?: unknown; kind?: unknown; error?: unknown; payload?: unknown }): void {
    if (typeof ev.turnId !== "string" || typeof ev.kind !== "string") return;
    let t = this.turns.get(ev.turnId);
    if (!t) {
      t = { startedAt: this.now(), steps: 0, heldError: null, workAfterError: false };
      this.turns.set(ev.turnId, t);
    }
    const kind = ev.kind;
    if (kind === "tool_progress") t.steps += 1;
    if (kind === "error" && ev.payload) {
      if (t.heldError === null || t.workAfterError) {
        t.heldError = typeof ev.error === "string" ? ev.error : "";
        t.workAfterError = false;
      }
      return;
    }
    if (t.heldError !== null && (kind === "delta" || kind === "tool_progress" || kind === "progress_note" || kind === "reasoning_progress")) {
      t.workAfterError = true;
    }
    let outcome: TurnOutcome | null = null;
    let error: string | null = null;
    if (kind === "aborted") outcome = "cancelled";
    else if (kind === "error") { outcome = "failed"; error = typeof ev.error === "string" ? ev.error : null; }
    else if (kind === "done") {
      if (t.heldError !== null && !t.workAfterError) { outcome = "failed"; error = t.heldError; }
      else outcome = "completed";
    }
    if (!outcome) return;
    this.turns.delete(ev.turnId);
    void this.finish(outcome, this.now() - t.startedAt, t.steps, error);
  }

  private async finish(outcome: TurnOutcome, durationMs: number, steps: number, error: string | null): Promise<void> {
    try {
      // Cancelled turns were stopped by someone, so there is nobody to tell.
      if (outcome === "cancelled") return;
      if (this.deps.isFocused()) return;
      const cfg = await this.deps.readConfig();
      if (!shouldNotify(outcome, durationMs, cfg)) return;
      // Focus may have come back while the config was being read.
      if (this.deps.isFocused()) return;
      this.deps.show(
        formatTurnNotification({ outcome, steps, durationMs, error, workingDirName: this.deps.workingDirName() }),
      );
    } catch {
      // A notifier must never be the thing that fails.
    }
  }
}
