import { arch, platform } from "node:os";
import type { CapabilitiesSummary } from "./stable-prefix.js";
import { runCommand } from "../sandbox/command-runner.js";

export interface BuildCapabilitiesInput {
  workingDir: string;
  browserChannel: string;
}

/**
 * Probe the host environment once per session to produce a stable
 * `CapabilitiesSummary`. The probes are intentionally conservative: we
 * only shell out to `which` and swallow failures so a missing binary
 * simply surfaces as `false` instead of crashing the sidecar.
 */
export async function buildCapabilities(
  input: BuildCapabilitiesInput,
): Promise<CapabilitiesSummary> {
  const [hasClipboard, hasWmctrl, hasNotifications] = await Promise.all([
    probeClipboard(),
    probeWmctrl(),
    probeNotifications(),
  ]);
  return {
    platform: platform(),
    arch: arch(),
    browserChannel: input.browserChannel,
    workingDir: input.workingDir,
    hasClipboard,
    hasWmctrl,
    hasNotifications,
  };
}

/** Resolve `which <bin>` to a boolean, swallowing every failure. */
export type WhichRunner = (bin: string) => Promise<boolean>;

async function defaultWhich(bin: string): Promise<boolean> {
  try {
    const result = await runCommand("which", [bin], {
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Clipboard availability. On Linux the npm `clipboardy` module being
 * importable says nothing — it shells out to `xclip` / `xsel` / `wl-copy`
 * at runtime, so we probe for one of those. On macOS / Windows the
 * platform ships a working backend (`pbcopy` / `clip.exe`), so the
 * module import is a sufficient signal.
 */
export async function probeClipboard(
  plat: NodeJS.Platform = platform(),
  which: WhichRunner = defaultWhich,
): Promise<boolean> {
  if (plat === "linux") {
    for (const bin of ["xclip", "xsel", "wl-copy"]) {
      if (await which(bin)) return true;
    }
    return false;
  }
  try {
    await import("clipboardy");
    return true;
  } catch {
    return false;
  }
}

/**
 * `wmctrl` window control. Linux-only — probed via `which`. macOS /
 * Windows use a native path, so they report `true` without a probe.
 */
export async function probeWmctrl(
  plat: NodeJS.Platform = platform(),
  which: WhichRunner = defaultWhich,
): Promise<boolean> {
  if (plat !== "linux") return plat === "darwin" || plat === "win32";
  return which("wmctrl");
}

/**
 * Desktop notifications. On Linux the `node-notifier` module shells out
 * to `notify-send`, so we probe for that binary. On macOS / Windows the
 * module import is sufficient (native backends).
 */
export async function probeNotifications(
  plat: NodeJS.Platform = platform(),
  which: WhichRunner = defaultWhich,
): Promise<boolean> {
  if (plat === "linux") {
    return which("notify-send");
  }
  try {
    await import("node-notifier");
    return true;
  } catch {
    return false;
  }
}
