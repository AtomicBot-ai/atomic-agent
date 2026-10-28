/**
 * ATO-1030 — a GPU process that keeps crashing turns hardware acceleration off.
 *
 * On Windows, Electron's GPU process crashes on some drivers (Sentry: ~23
 * people in 30 days), and each crash can leave the window black or frozen
 * until it is force-closed. Chromium restarts the GPU process itself, but a
 * driver that crashes it once tends to crash it again. So: a second GPU crash
 * within GPU_CRASH_WINDOW_MS writes `off: "auto"`, and the next launch calls
 * `app.disableHardwareAcceleration()` (main.ts, before the app is ready, the
 * only time Electron honours it). Settings › Diagnostics shows the state and
 * turns it back on or off by hand (`off: "user"`); either takes effect at the
 * next launch.
 *
 * The file lives in userData (gpu.json), not the agent's state folder: it is
 * about this machine's graphics, not about the person's settings.
 *
 * Pure apart from the file read and write; the clock is handed in.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GPU_CRASH_WINDOW_MS = 10 * 60_000;
export const GPU_CRASHES_TO_FALL_BACK = 2;

export interface GpuState {
  /** ms epochs of the recent GPU process crashes. */
  crashes: number[];
  /** Hardware acceleration off: after crashes, by the person, or not (null). */
  off: "auto" | "user" | null;
}

const EMPTY: GpuState = { crashes: [], off: null };

function file(userData: string): string {
  return join(userData, "gpu.json");
}

export function readGpuState(userData: string): GpuState {
  try {
    const raw = JSON.parse(readFileSync(file(userData), "utf8")) as Partial<GpuState>;
    const crashes = Array.isArray(raw.crashes) ? raw.crashes.filter((t): t is number => typeof t === "number" && Number.isFinite(t)) : [];
    const off = raw.off === "auto" || raw.off === "user" ? raw.off : null;
    return { crashes, off };
  } catch {
    return { ...EMPTY };
  }
}

export function writeGpuState(userData: string, state: GpuState): void {
  try {
    writeFileSync(file(userData), `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    /* a read-only userData keeps acceleration on, as before */
  }
}

/** A GPU process crash: the state after it, and whether this one turned acceleration off. */
export function noteGpuCrash(state: GpuState, now: number): { state: GpuState; turnedOff: boolean } {
  const crashes = [...state.crashes.filter((t) => now - t < GPU_CRASH_WINDOW_MS), now];
  if (state.off !== null) return { state: { ...state, crashes }, turnedOff: false };
  const turnedOff = crashes.length >= GPU_CRASHES_TO_FALL_BACK;
  return { state: { crashes, off: turnedOff ? "auto" : null }, turnedOff };
}

/** The person's switch in Settings › Diagnostics. Turning it back on forgets the crashes. */
export function setHardwareAcceleration(state: GpuState, on: boolean): GpuState {
  return on ? { crashes: [], off: null } : { ...state, off: "user" };
}
