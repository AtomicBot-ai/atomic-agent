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

async function probeClipboard(): Promise<boolean> {
  try {
    await import("clipboardy");
    return true;
  } catch {
    return false;
  }
}

async function probeWmctrl(): Promise<boolean> {
  if (platform() !== "linux") return platform() === "darwin" || platform() === "win32";
  try {
    const result = await runCommand("which", ["wmctrl"], {
      cwd: process.cwd(),
      timeoutMs: 2000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function probeNotifications(): Promise<boolean> {
  try {
    await import("node-notifier");
    return true;
  } catch {
    return false;
  }
}
