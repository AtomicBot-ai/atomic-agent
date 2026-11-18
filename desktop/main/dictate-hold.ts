import { join } from "node:path";

/**
 * ATO-1064: hold to talk, the way Wispr Flow does it. Hold Fn on a Mac, or
 * Ctrl+Win on Windows: while the keys are down the take records, letting go
 * types the words into the app in front. Electron's globalShortcut sees
 * neither Fn nor a key going up, so a small watcher process reports the
 * keys: native/atomic-fn-key.swift on a Mac, a PowerShell low-level
 * keyboard hook on Windows. It swallows nothing and says nothing about any
 * other key except while the hold keys are down (then only `esc` or
 * `other`). Linux has no agreed hold key and keeps the toggle combo.
 *
 * Pure (no Electron import) so the node tests load it as is:
 * the hold state machine, the watcher's line protocol, the command that
 * starts the watcher, and the line Settings shows when it cannot run.
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

/** One stdout line of the watcher, or null for anything else (PowerShell noise, blank lines). */
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
 * The Windows watcher: a WH_KEYBOARD_LL hook compiled by Add-Type, with its
 * own message loop. It prints `down` when Ctrl and Win are both held and
 * `up` when either comes up; `esc` / `other` for a key pressed meanwhile.
 * Every event goes on to CallNextHookEx, so nothing is swallowed. When the
 * chord starts it sends one press of an unassigned key (0xE8, AutoHotkey's
 * "menu mask" trick), so letting go of Win does not open the Start menu; the
 * hook skips that key. It exits when its stdin closes (the app quit or died).
 */
export const WINDOWS_HOLD_KEY_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class AtomicHoldKey {
  private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  private struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWindowsHookEx(int idHook, HookProc fn, IntPtr hMod, uint threadId);
  [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern int GetMessage(out MSG msg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandle(string name);

  private const uint MASK_KEY = 0xE8;
  private static readonly HookProc Proc = OnKey;   // held, so the GC never collects the hook
  private static IntPtr hook = IntPtr.Zero;
  private static bool lctrl, rctrl, lwin, rwin, active;

  private static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }
  private static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  private static IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam) {
    if (nCode >= 0) {
      KBDLLHOOKSTRUCT k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      int msg = wParam.ToInt32();
      bool down = msg == 0x100 || msg == 0x104;
      bool up = msg == 0x101 || msg == 0x105;
      if (k.vkCode != MASK_KEY && (down || up)) {
        switch (k.vkCode) {
          case 0xA2: lctrl = down; break;
          case 0xA3: rctrl = down; break;
          case 0x5B: lwin = down; break;
          case 0x5C: rwin = down; break;
          case 0x11: break;
          default:
            // A missed key-up (the secure desktop, a UAC prompt) is put right from the real state.
            lctrl = Down(0xA2); rctrl = Down(0xA3); lwin = Down(0x5B); rwin = Down(0x5C);
            if (active && down) Say(k.vkCode == 0x1B ? "esc" : "other");
            break;
        }
        bool both = (lctrl || rctrl) && (lwin || rwin);
        if (both && !active) {
          active = true;
          Say("down");
          keybd_event((byte)MASK_KEY, 0, 0, UIntPtr.Zero);
          keybd_event((byte)MASK_KEY, 0, 2, UIntPtr.Zero);
        } else if (!both && active) {
          active = false;
          Say("up");
        }
      }
    }
    return CallNextHookEx(hook, nCode, wParam, lParam);
  }

  public static void Run() {
    Thread watch = new Thread(() => { while (Console.In.ReadLine() != null) { } Environment.Exit(0); });
    watch.IsBackground = true;
    watch.Start();
    hook = SetWindowsHookEx(13, Proc, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) { Say("error SetWindowsHookEx failed (" + Marshal.GetLastWin32Error() + ")"); Environment.Exit(4); }
    Say("ready");
    MSG m;
    while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
  }
}
'@
try { Add-Type -TypeDefinition $src -Language CSharp } catch { [Console]::Out.WriteLine('error ' + ($_.Exception.Message -split "\r?\n")[0]); exit 4 }
[AtomicHoldKey]::Run()
`;

/**
 * How the watcher is started here, or null where there is none. `nativeDir`
 * is where the Mac helper lives (Resources/native when packaged,
 * out/native in a dev run).
 */
export function holdKeyCommand(
  platform: NodeJS.Platform | string,
  nativeDir: string,
  env: Record<string, string | undefined>,
): WatcherCommand | null {
  if (platform === "darwin") return { file: join(nativeDir, "atomic-fn-key"), args: [] };
  if (platform === "win32") {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir;
    const file = root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
    const encoded = Buffer.from(WINDOWS_HOLD_KEY_SCRIPT, "utf16le").toString("base64");
    return { file, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded] };
  }
  return null;
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
