import { WinHoldChord, type HoldKeyLine, type HoldWatchState } from "./dictate-hold.js";

/**
 * ATO-1064: the Windows hold key watcher, inside the app. uiohook-napi is a
 * native module (N-API prebuilds for win32-x64 and win32-arm64, so no
 * rebuild for Electron) with a low-level keyboard hook on its own thread;
 * its keydown/keyup go through WinHoldChord into the same lines the Mac
 * helper prints. No process is started, so there is no hidden PowerShell
 * for an antivirus to flag and nothing for Constrained Language Mode to
 * block.
 *
 * The module is loaded the first time the watcher starts, which happens only
 * on Windows with the hold mode on. If it cannot be loaded or started the
 * state is `failed`, and the toggle combo stands in, as it does for a Mac
 * helper that stopped. Same surface as HoldKeyWatcher.
 */

export interface UiohookKeyEvent {
  keycode: number;
}

/** As much of uiohook-napi's `uIOhook` as this needs. */
export interface UiohookLike {
  on(event: "keydown" | "keyup", fn: (e: UiohookKeyEvent) => void): unknown;
  removeListener(event: "keydown" | "keyup", fn: (e: UiohookKeyEvent) => void): unknown;
  start(): void;
  stop(): void;
}

/** The real module, loaded on first use. Throws when it is missing or its .node file cannot load. */
export function loadUiohook(): UiohookLike {
  const mod = require("uiohook-napi") as { uIOhook?: UiohookLike };
  if (!mod || !mod.uIOhook) throw new Error("uiohook-napi has no uIOhook");
  return mod.uIOhook;
}

export class UiohookHoldWatcher {
  private hook: UiohookLike | null = null;
  private st: HoldWatchState = "off";
  private why: string | null = null;
  private readonly chord = new WinHoldChord();
  private readonly onDown = (e: UiohookKeyEvent) => this.feed("down", e);
  private readonly onUp = (e: UiohookKeyEvent) => this.feed("up", e);

  constructor(
    private readonly onKey: (line: HoldKeyLine) => void,
    private readonly onState: (st: HoldWatchState) => void,
    private readonly log: (line: string) => void,
    private readonly load: () => UiohookLike = loadUiohook,
  ) {}

  get state(): HoldWatchState {
    return this.st;
  }

  /** The last error, for Settings. */
  get detail(): string | null {
    return this.why;
  }

  /** Starts it unless it runs. A failed one is tried again. */
  start(): void {
    if (this.hook) return;
    this.why = null;
    this.set("starting");
    let hook: UiohookLike;
    try {
      hook = this.load();
    } catch (err) {
      this.fail("could not load the key watcher", err);
      return;
    }
    this.chord.clear();
    try {
      hook.on("keydown", this.onDown);
      hook.on("keyup", this.onUp);
      hook.start();
    } catch (err) {
      try { hook.removeListener("keydown", this.onDown); hook.removeListener("keyup", this.onUp); } catch { /* gone */ }
      this.fail("could not start the key watcher", err);
      return;
    }
    this.hook = hook;
    this.set("ready");
  }

  stop(): void {
    const hook = this.hook;
    this.hook = null;
    this.chord.clear();
    if (hook) {
      try { hook.removeListener("keydown", this.onDown); hook.removeListener("keyup", this.onUp); } catch { /* gone */ }
      try { hook.stop(); } catch { /* gone */ }
    }
    this.set("off");
  }

  private feed(kind: "down" | "up", e: UiohookKeyEvent): void {
    if (!this.hook || !e || typeof e.keycode !== "number") return;
    const line = this.chord.key(kind, e.keycode);
    if (line) this.onKey(line);
  }

  private fail(what: string, err: unknown): void {
    const msg = err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err);
    this.why = what;
    this.log(`[desktop] hold key watcher: ${what}: ${msg.slice(0, 200)}`);
    this.set("failed");
  }

  private set(st: HoldWatchState): void {
    if (this.st === st) return;
    this.st = st;
    this.onState(st);
  }
}
