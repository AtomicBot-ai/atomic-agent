import { mkdir, stat } from "node:fs/promises";
import { platform } from "node:os";
import { runCommand } from "../../../sandbox/command-runner.js";
import { buildScreenInvocation, type ScreenOp } from "./screen-jxa.js";

/**
 * Everything the screen tools need from the host, injectable so tests
 * never touch the real screen, mouse or keyboard.
 */
export interface ScreenCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type ScreenRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  },
) => Promise<ScreenCommandResult>;

export interface ScreenDeps {
  run: ScreenRunner;
  platform: NodeJS.Platform;
  /** The agent's environment: names the host app in permission messages. */
  env: NodeJS.ProcessEnv;
  fileSize: (path: string) => Promise<number>;
  ensureDir: (path: string) => Promise<void>;
  now: () => Date;
}

export const defaultScreenRunner: ScreenRunner = (command, args, options) =>
  runCommand(command, [...args], {
    cwd: options.cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

export function resolveScreenDeps(overrides: Partial<ScreenDeps> = {}): ScreenDeps {
  return {
    run: overrides.run ?? defaultScreenRunner,
    platform: overrides.platform ?? platform(),
    env: overrides.env ?? process.env,
    fileSize: overrides.fileSize ?? (async (path) => (await stat(path)).size),
    ensureDir:
      overrides.ensureDir ??
      (async (path) => {
        await mkdir(path, { recursive: true });
      }),
    now: overrides.now ?? (() => new Date()),
  };
}

/** What one JXA run reports about the host before (and after) acting. */
export interface ScreenProbe {
  /** `AXIsProcessTrusted` for the host app; `null` when it could not be asked. */
  accessibility: boolean | null;
  /** `CGPreflightScreenCaptureAccess`; `null` when it could not be asked. */
  screenRecording: boolean | null;
  frontmost: { name: string | null; bundleId: string | null } | null;
  /** Main display in points, and its pixels per point. */
  screen: { width: number; height: number; scale: number };
  done: boolean;
  error?: string;
}

export const SCREEN_JXA_TIMEOUT_MS = 15_000;

/** Run one screen operation and parse its report; throws on a broken run. */
export async function runScreenOp(
  deps: ScreenDeps,
  operation: ScreenOp,
  ctx: { workingDir: string; signal: AbortSignal },
): Promise<ScreenProbe> {
  const call = buildScreenInvocation(operation, deps.env);
  const result = await deps.run(call.command, call.args, {
    cwd: ctx.workingDir,
    signal: ctx.signal,
    timeoutMs: SCREEN_JXA_TIMEOUT_MS,
    env: call.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `osascript failed (exit ${result.exitCode ?? "none"}): ${result.stderr.trim() || "no output"}`,
    );
  }
  return parseScreenProbe(result.stdout);
}

export function parseScreenProbe(stdout: string): ScreenProbe {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`unexpected osascript output: ${stdout.trim().slice(0, 200)}`);
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const screen = (obj.screen ?? {}) as Record<string, unknown>;
  const width = Number(screen.width);
  const height = Number(screen.height);
  const scale = Number(screen.scale);
  if (!(width > 0) || !(height > 0)) {
    throw new Error("osascript reported no main screen");
  }
  const front = obj.frontmost as Record<string, unknown> | null | undefined;
  return {
    accessibility: typeof obj.accessibility === "boolean" ? obj.accessibility : null,
    screenRecording:
      typeof obj.screenRecording === "boolean" ? obj.screenRecording : null,
    frontmost:
      front && typeof front === "object"
        ? {
            name: typeof front.name === "string" ? front.name : null,
            bundleId: typeof front.bundleId === "string" ? front.bundleId : null,
          }
        : null,
    screen: { width, height, scale: scale > 0 ? scale : 1 },
    done: obj.done === true,
    ...(typeof obj.error === "string" ? { error: obj.error } : {}),
  };
}

const TERM_PROGRAM_NAMES: Readonly<Record<string, string>> = {
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  vscode: "Visual Studio Code",
  WarpTerminal: "Warp",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
};

/**
 * The app macOS asks permission for: the one that launched the agent.
 * TCC attributes `osascript` to its responsible app, not to Node.
 */
export function hostAppName(env: NodeJS.ProcessEnv): string {
  const term = env.TERM_PROGRAM;
  if (term && TERM_PROGRAM_NAMES[term]) return TERM_PROGRAM_NAMES[term]!;
  if (term) return term;
  const bundle = env.__CFBundleIdentifier;
  if (bundle) return bundle;
  return "the app that runs Atomic Agent (your terminal or Atomic Agent Desktop)";
}

export function accessibilityMessage(env: NodeJS.ProcessEnv): string {
  const host = hostAppName(env);
  return (
    `macOS has not given ${host} Accessibility permission, so the agent cannot click or type. ` +
    `Ask the user to open System Settings → Privacy & Security → Accessibility, turn on ${host}, ` +
    "and restart it. Nothing was clicked or typed. Do not retry until the user says it is done."
  );
}

export function screenRecordingMessage(env: NodeJS.ProcessEnv): string {
  const host = hostAppName(env);
  return (
    `macOS has not given ${host} Screen Recording permission, so the screenshot would show no windows. ` +
    `Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording ` +
    `(Screen Recording on older macOS), turn on ${host}, and restart it. ` +
    "Do not retry until the user says it is done."
  );
}

export function macOnlyMessage(tool: string, os: NodeJS.Platform): string {
  return `${tool} works on macOS only (this is ${os}); Windows and Linux support is tracked in ATO-527.`;
}
