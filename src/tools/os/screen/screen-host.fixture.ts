import type { ToolContext } from "../../tool-registry.js";
import { SCREEN_PAYLOAD_ENV } from "./screen-jxa.js";
import type { ScreenCommandResult, ScreenDeps } from "./screen-host.js";

/** One recorded host command, with the screen operation decoded when it is one. */
export interface RecordedCall {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  op?: Record<string, unknown>;
}

export interface FakeHost {
  deps: ScreenDeps;
  calls: RecordedCall[];
  /** The screen operations only (`probe`, `click`, ...), in order. */
  ops: () => Record<string, unknown>[];
}

export interface FakeHostOptions {
  accessibility?: boolean | null;
  screenRecording?: boolean | null;
  frontmost?: { name: string; bundleId: string } | null;
  /** Frontmost app the ACTION run reports (simulates a switch after approval). */
  frontmostAtAction?: { name: string; bundleId: string } | null;
  screen?: { width: number; height: number; scale: number };
  /** `sips -g` answers, in order; the last one repeats. */
  pixelSizes?: { width: number; height: number }[];
  screencaptureExit?: number;
  fileSize?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * A host that never touches the real machine: osascript answers with a
 * canned probe, screencapture and sips with canned exits and sizes.
 */
export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const calls: RecordedCall[] = [];
  const sizes = [...(options.pixelSizes ?? [{ width: 2880, height: 1800 }])];
  const front = options.frontmost === undefined
    ? { name: "Safari", bundleId: "com.apple.Safari" }
    : options.frontmost;
  const run = async (
    command: string,
    args: readonly string[],
    opts: { env?: NodeJS.ProcessEnv },
  ): Promise<ScreenCommandResult> => {
    const raw = opts.env?.[SCREEN_PAYLOAD_ENV];
    const op = raw === undefined ? undefined : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ command, args, ...(opts.env ? { env: opts.env } : {}), ...(op ? { op } : {}) });
    if (command === "osascript") {
      const acting = op?.op !== "probe";
      const accessibility = options.accessibility === undefined ? true : options.accessibility;
      const frontmost = acting && options.frontmostAtAction !== undefined ? options.frontmostAtAction : front;
      const report: Record<string, unknown> = {
        accessibility,
        screenRecording: options.screenRecording === undefined ? true : options.screenRecording,
        frontmost,
        screen: options.screen ?? { width: 1440, height: 900, scale: 2 },
        done: false,
      };
      if (acting) {
        if (accessibility !== true) report.error = "accessibility";
        else if (op?.expectBundleId && op.expectBundleId !== frontmost?.bundleId) report.error = "frontmost-changed";
        else report.done = true;
      }
      return { exitCode: 0, stdout: JSON.stringify(report), stderr: "" };
    }
    if (command === "screencapture") {
      const exit = options.screencaptureExit ?? 0;
      return { exitCode: exit, stdout: "", stderr: exit === 0 ? "" : "could not create image from display" };
    }
    if (command === "sips" && args[0] === "-g") {
      const size = sizes.length > 1 ? sizes.shift()! : sizes[0]!;
      return { exitCode: 0, stdout: `/x.jpg\n  pixelWidth: ${size.width}\n  pixelHeight: ${size.height}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const deps: ScreenDeps = {
    run,
    platform: options.platform ?? "darwin",
    env: options.env ?? { TERM_PROGRAM: "Apple_Terminal" },
    fileSize: async () => options.fileSize ?? 123_456,
    ensureDir: async () => undefined,
    now: () => new Date(2026, 9, 25, 14, 22, 33, 417),
  };
  return {
    deps,
    calls,
    ops: () => calls.flatMap((call) => (call.op ? [call.op] : [])),
  };
}

export function screenCtx(sessionId = "s1"): ToolContext {
  return {
    workingDir: "/work",
    sessionId,
    stepIndex: 0,
    signal: new AbortController().signal,
  };
}
