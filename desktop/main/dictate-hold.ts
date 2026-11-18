import { join } from "node:path";

/**
 * ATO-1064: hold to talk, the way Wispr Flow does it. Hold Fn on a Mac, or
 * Ctrl+Win on Windows: while the keys are down the take records, letting go
 * types the words into the app in front. Electron's globalShortcut sees
 * neither Fn nor a key going up, so a watcher reports the keys: on a Mac
 * the small helper process native/atomic-fn-key.swift, on Windows the
 * in-process native module uiohook-napi (hold-key-uiohook.ts), loaded only
 * there and only while the hold mode is on. Neither swallows a key, and
 * neither says anything about any other key except while the hold keys are
 * down (then only `esc` or `other`). Linux has no agreed hold key and keeps
 * the toggle combo.
 *
 * Pure (no Electron import) so the node tests load it as is:
 * the hold state machine, the watcher's line protocol, the command that
 * starts the Mac helper, the Windows key events turned into the same lines,
 * and the line Settings shows when it cannot run.
 */

/* ---------------- which key ---------------- */

export type HoldKey = "fn" | "ctrl+win";

/** The key held to talk on this platform, or null where there is none (Linux). */
export function holdKeyFor(platform: NodeJS.Platform | string): HoldKey | null {
  if (platform === "darwin") return "fn";
  if (platform === "win32") return "ctrl+win";
  return null;
}

/** How Settings and the pill name it. */
export function holdKeyLabel(platform: NodeJS.Platform | string): string | null {
  const k = holdKeyFor(platform);
  return k === "fn" ? "Fn" : k === "ctrl+win" ? "Ctrl+Win" : null;
}

/* ---------------- the hold ---------------- */

/** A press shorter than this is a tap: no take starts (Fn alone is also the emoji key). */
export const HOLD_START_DELAY_MS = 200;

export type HoldAction = "start" | "finish" | "cancel";

export interface HoldTimers {
  set(ms: number, fn: () => void): unknown;
  clear(handle: unknown): void;
}

/**
 * The keys' down/up/esc/other, turned into start/finish/cancel:
 * - down, held past HOLD_START_DELAY_MS: start.
 * - up before that (a tap): nothing at all.
 * - up after start: finish (the words are typed).
 * - Esc, or another key, while held: before start nothing starts; after
 *   start the take is thrown away. Either way the rest of that hold is
 *   ignored until the keys come up.
 * - the watcher went away while held (reset): cancel, since no up will come.
 */
export class HoldMachine {
  private st: "idle" | "pending" | "held" | "ignored" = "idle";
  private timer: unknown = null;

  constructor(
    private readonly timers: HoldTimers,
    private readonly act: (a: HoldAction) => void,
    private readonly delayMs = HOLD_START_DELAY_MS,
  ) {}

  get state(): "idle" | "pending" | "held" | "ignored" {
    return this.st;
  }

  down(): void {
    if (this.st !== "idle") return;   // key repeat, or a second down without an up
    this.st = "pending";
    this.timer = this.timers.set(this.delayMs, () => {
      this.timer = null;
      if (this.st !== "pending") return;
      this.st = "held";
      this.act("start");
    });
  }

  up(): void {
    const was = this.st;
    this.clearTimer();
    this.st = "idle";
    if (was === "held") this.act("finish");
  }

  /** Esc while held. */
  esc(): void {
    this.abort();
  }

  /** Another key while held: a chord (Fn+arrow, Ctrl+Win+D), not dictation. */
  other(): void {
    this.abort();
  }

  /** The watcher stopped: forget the hold, and drop a take it had started. */
  reset(): void {
    const was = this.st;
    this.clearTimer();
    this.st = "idle";
    if (was === "held") this.act("cancel");
  }

  private abort(): void {
    if (this.st === "idle" || this.st === "ignored") return;
    const was = this.st;
    this.clearTimer();
    this.st = "ignored";
    if (was === "held") this.act("cancel");
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}

/* ---------------- the watcher's lines ---------------- */

export type HoldKeyLine =
  | { type: "ready" }
  | { type: "down" }
  | { type: "up" }
  | { type: "esc" }
  | { type: "other" }
  | { type: "untrusted" }
  | { type: "error"; message: string };

/** One stdout line of the watcher, or null for anything else (noise, blank lines). */
export function parseHoldKeyLine(raw: string): HoldKeyLine | null {
  const line = raw.replace(/^﻿/, "").trim();
  if (line === "ready" || line === "down" || line === "up" || line === "esc" || line === "other" || line === "untrusted") {
    return { type: line };
  }
  if (line === "error" || line.startsWith("error ")) {
    return { type: "error", message: line.slice(5).trim().slice(0, 200) || "the key watcher failed" };
  }
  return null;
}

/** Splits a stdout stream into whole lines; the tail waits for the next chunk. */
export class LineBuffer {
  private rest = "";

  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const parts = text.split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    if (this.rest.length > 4096) this.rest = "";   // never a line of ours
    return parts;
  }
}

/* ---------------- starting the watcher ---------------- */

export interface WatcherCommand {
  file: string;
  args: string[];
}

/**
 * How the watcher process is started here, or null where there is none.
 * Only the Mac has one: `nativeDir` is where its helper lives
 * (Resources/native when packaged, out/native in a dev run). Windows starts
 * no process at all; its watcher runs inside the app (WinHoldChord below).
 */
export function holdKeyCommand(platform: NodeJS.Platform | string, nativeDir: string): WatcherCommand | null {
  if (platform === "darwin") return { file: join(nativeDir, "atomic-fn-key"), args: [] };
  return null;
}

/* ---------------- the Windows keys ---------------- */

/**
 * uiohook-napi's key codes (its UiohookKey, the libuiohook VC_ values) for
 * the keys the Windows hold watches. Kept here so the mapping is tested
 * without the native module.
 */
export const UIOHOOK_KEYS = {
  escape: 1,
  ctrl: 29,
  ctrlRight: 3613,
  meta: 3675,
  metaRight: 3676,
} as const;

/**
 * Ctrl+Win from uiohook-napi's keydown/keyup events, as the same lines the
 * Mac helper prints: `down` when a Ctrl and a Win key are both held, `up`
 * when either comes up, `esc` or `other` for a key pressed meanwhile. Key
 * repeat is harmless (a held key going down again changes nothing). The
 * events are only read: uiohook-napi passes every key on, so nothing is
 * swallowed.
 *
 * Letting go of Win after Ctrl+Win may open the Start menu: the old
 * PowerShell watcher sent one press of an unassigned key (0xE8) to stop
 * that, and uiohook-napi can only press keys it has a code for, none of them
 * unassigned, so that is left out rather than pressing a real key into the
 * app in front.
 */
export class WinHoldChord {
  private lctrl = false;
  private rctrl = false;
  private lwin = false;
  private rwin = false;
  private active = false;

  /** One key event; the line it makes, or null. */
  key(kind: "down" | "up", keycode: number): HoldKeyLine | null {
    const down = kind === "down";
    switch (keycode) {
      case UIOHOOK_KEYS.ctrl: this.lctrl = down; break;
      case UIOHOOK_KEYS.ctrlRight: this.rctrl = down; break;
      case UIOHOOK_KEYS.meta: this.lwin = down; break;
      case UIOHOOK_KEYS.metaRight: this.rwin = down; break;
      default:
        return this.active && down ? { type: keycode === UIOHOOK_KEYS.escape ? "esc" : "other" } : null;
    }
    const both = (this.lctrl || this.rctrl) && (this.lwin || this.rwin);
    if (both && !this.active) { this.active = true; return { type: "down" }; }
    if (!both && this.active) { this.active = false; return { type: "up" }; }
    return null;
  }

  /** Forget the keys (the watcher stopped). */
  clear(): void {
    this.lctrl = this.rctrl = this.lwin = this.rwin = this.active = false;
  }
}

/* ---------------- what Settings says ---------------- */

export type HoldWatchState = "off" | "starting" | "ready" | "untrusted" | "missing" | "failed";

/** The watcher cannot run: the toggle combo stands in for the hold key. */
export function holdWatchFailed(st: HoldWatchState): boolean {
  return st === "untrusted" || st === "missing" || st === "failed";
}

/**
 * The warning under the row when the hold key cannot be watched, or null.
 * `toggleLabel` is the combo that works meanwhile.
 */
export function holdWatchLine(st: HoldWatchState, platform: NodeJS.Platform | string, toggleLabel: string, detail?: string | null): string | null {
  const key = holdKeyLabel(platform) ?? "the hold key";
  const meanwhile = toggleLabel ? ` Until then ${toggleLabel} starts and ends a take.` : "";
  if (st === "untrusted") {
    return `Holding ${key} needs Accessibility: System Settings › Privacy & Security › Accessibility, then turn on Atomic Agent.${meanwhile}`;
  }
  if (st === "missing") return `This build has no ${key} key watcher.${meanwhile}`;
  if (st === "failed") return `The ${key} key watcher stopped${detail ? ` (${detail})` : ""}.${meanwhile}`;
  return null;
}

/** The note under the row about Fn opening the emoji picker (macOS only). */
export function holdKeyNote(platform: NodeJS.Platform | string): string | null {
  return platform === "darwin"
    ? 'If Fn opens the emoji picker or macOS Dictation, set System Settings › Keyboard › "Press 🌐 key to" to Do Nothing.'
    : null;
}

/** The pane the Open Privacy Settings button opens, or null off macOS. */
export function dictatePrivacyUrl(platform: NodeJS.Platform | string): string | null {
  return platform === "darwin" ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" : null;
}
