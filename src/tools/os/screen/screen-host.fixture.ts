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

type App = { name: string; bundleId: string } | null;

export interface FakeHostOptions {
  accessibility?: boolean | null;
  screenRecording?: boolean | null;
  frontmost?: App;
  /** What a probe with a point reports as the window owner there (default: the frontmost app). */
  ownerAtPoint?: App;
  /**
   * Fields the ACTION run reports, verbatim (default `{ done: true }`).
   * The fixture decides nothing: refusals belong to the JXA source and
   * the TypeScript flow, and are tested there, not imitated here.
   */
  actionReport?: Record<string, unknown>;
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
 * canned report, screencapture and sips with canned exits and sizes.
 */
export function fakeHost(options: FakeHostOptions = {}): FakeHost {
  const calls: RecordedCall[] = [];
  const sizes = [...(options.pixelSizes ?? [{ width: 2880, height: 1800 }])];
  const front: App = options.frontmost === undefined
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
      const report: Record<string, unknown> = {
        accessibility: options.accessibility === undefined ? true : options.accessibility,
        screenRecording: options.screenRecording === undefined ? true : options.screenRecording,
        frontmost: front,
        screen: options.screen ?? { width: 1440, height: 900, scale: 2 },
        done: false,
      };
      if (op?.op === "probe") {
        if (op.point) report.ownerAtPoint = options.ownerAtPoint === undefined ? front : options.ownerAtPoint;
      } else {
        Object.assign(report, options.actionReport ?? { done: true });
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
    env: options.env ?? { TERM_PROGRAM: "Apple_Terminal", PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-secret" },
    fileSize: async () => options.fileSize ?? 123_456,
    ensureDir: async () => undefined,
    now: () => new Date(2026, 9, 25, 14, 22, 33, 417),
    tmpDir: "/tmp/t",
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
