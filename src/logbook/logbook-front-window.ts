import { runScreenOp, type ScreenDeps } from "../tools/os/screen/screen-host.js";
import { probeLinuxFrontWindow } from "./logbook-front-window-linux.js";
import { probeWindowsFrontWindow } from "./logbook-front-window-win.js";
import type { FrontApp } from "./logbook-skip.js";

/**
 * Which window is in front, for one logbook frame (ATO-2526): the app
 * (bundle id on macOS, process name on Windows, window class on X11),
 * its window title, and how long the person has not touched the mouse
 * or keyboard. macOS asks the screen tools' JXA probe and `ioreg`;
 * Windows and Linux have their own files. `ok: false` carries the plain
 * reason the frame is not taken (Wayland, no X11 tool, no display).
 */
export interface FrontWindowProbe {
  app: FrontApp | null;
  /** Empty when unknown or hidden (macOS without Screen Recording). */
  title: string;
  /** Milliseconds since the last input; `null` when it could not be read. */
  idleMs: number | null;
  /** macOS Screen Recording grant; `null` elsewhere or when unknown. */
  screenRecording: boolean | null;
}

export type FrontWindowResult = { ok: true; probe: FrontWindowProbe } | { ok: false; reason: string };

export interface FrontWindowCtx {
  workingDir: string;
  signal: AbortSignal;
}

/** `"HIDIdleTime" = 1234567890` (nanoseconds) from `ioreg -c IOHIDSystem`. */
export function parseMacIdleMs(stdout: string): number | null {
  const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(stdout)?.[1];
  return ns === undefined ? null : Math.floor(Number(ns) / 1_000_000);
}

async function macIdleMs(screen: ScreenDeps, ctx: FrontWindowCtx): Promise<number | null> {
  try {
    const out = await screen.run("ioreg", ["-c", "IOHIDSystem", "-d", "4"], { cwd: ctx.workingDir, signal: ctx.signal, timeoutMs: 5_000 });
    return out.exitCode === 0 ? parseMacIdleMs(out.stdout) : null;
  } catch {
    return null;
  }
}

async function probeMac(screen: ScreenDeps, ctx: FrontWindowCtx, withTitle: boolean): Promise<FrontWindowResult> {
  const probe = await runScreenOp(screen, { op: "probe", ...(withTitle ? { windows: true } : {}) }, ctx);
  const front = probe.frontmost ?? null;
  const title = withTitle && front?.bundleId ? (probe.windows?.find((w) => w.bundleId === front.bundleId)?.title ?? "") : "";
  return {
    ok: true,
    probe: { app: front, title, idleMs: await macIdleMs(screen, ctx), screenRecording: probe.screenRecording },
  };
}

export async function probeFrontWindow(screen: ScreenDeps, ctx: FrontWindowCtx, options: { withTitle: boolean }): Promise<FrontWindowResult> {
  if (screen.platform === "darwin") return probeMac(screen, ctx, options.withTitle);
  if (screen.platform === "win32") return probeWindowsFrontWindow(screen, ctx);
  if (screen.platform === "linux") return probeLinuxFrontWindow(screen, ctx);
  return { ok: false, reason: "the logbook works on macOS, Windows and Linux (X11) only" };
}
