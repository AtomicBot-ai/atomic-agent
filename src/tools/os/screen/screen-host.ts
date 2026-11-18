import { chmod, lstat, mkdir, open, stat, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname } from "node:path";
import { runCommand } from "../../../sandbox/command-runner.js";
import { buildScreenInvocation, type ScreenFrame, type ScreenOp } from "./screen-jxa.js";
import { parseElement, type ScreenElement } from "./screen-elements.js";
import type { ScreenWindow } from "./screen-window.js";

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
  /** The first `bytes` of a file (a PNG header on Windows/Linux captures). */
  readHead: (path: string, bytes: number) => Promise<Uint8Array>;
  ensureDir: (path: string) => Promise<void>;
  /** Saves a window's text next to its snapshot. */
  writeText: (path: string, text: string) => Promise<void>;
  now: () => Date;
  /** Base for screenshots (`os.tmpdir()`): already a read root, never the working folder. */
  tmpDir: string;
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
    readHead:
      overrides.readHead ??
      (async (path, bytes) => {
        const file = await open(path, "r");
        try {
          const buffer = Buffer.alloc(bytes);
          const { bytesRead } = await file.read(buffer, 0, bytes, 0);
          return buffer.subarray(0, bytesRead);
        } finally {
          await file.close();
        }
      }),
    ensureDir:
      overrides.ensureDir ??
      (async (path) => {
        await ensurePrivateDir(path);
      }),
    writeText:
      overrides.writeText ??
      (async (path, text) => {
        await writeFile(path, text, "utf8");
      }),
    now: overrides.now ?? (() => new Date()),
    tmpDir: overrides.tmpDir ?? tmpdir(),
  };
}

/** The file-system calls `ensurePrivateDir` makes; injectable for tests. */
export interface PrivateDirFs {
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  lstat: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; uid: number }>;
  chmod: (path: string, mode: number) => Promise<void>;
  /** `process.getuid()`; `null` where there is none (Windows). */
  uid: () => number | null;
}

const NODE_PRIVATE_DIR_FS: PrivateDirFs = {
  mkdir: (path, options) => mkdir(path, options),
  lstat: (path) => lstat(path),
  chmod: (path, mode) => chmod(path, mode),
  uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
};

/**
 * Make the screenshot folder and its parent private to this user.
 *
 * The folder lives under `os.tmpdir()`. On macOS that is a per-user 0700
 * folder, but on Linux it is the shared `/tmp`, where another local user
 * could read a full-screen capture, or pre-create the predictable
 * `atomic-agent-screens` parent (or a symlink) and own what lands inside.
 * So both levels are created 0700, must be real directories (not
 * symlinks) owned by this user, and are set back to 0700 if they were
 * looser. Anything else refuses the capture. Windows has no uid and a
 * per-user temp folder; only the symlink check applies there.
 */
export async function ensurePrivateDir(
  path: string,
  fs: PrivateDirFs = NODE_PRIVATE_DIR_FS,
): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const uid = fs.uid();
  for (const dir of [dirname(path), path]) {
    const info = await fs.lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`screenshot folder ${dir} is not a plain folder; refusing to save a capture there`);
    }
    if (uid !== null && info.uid !== uid) {
      throw new Error(
        `screenshot folder ${dir} belongs to another user; remove it and try again`,
      );
    }
    if (uid !== null) await fs.chmod(dir, 0o700);
  }
}

export interface ScreenApp {
  name: string | null;
  bundleId: string | null;
}

/** What one JXA run reports about the host before (and after) acting. */
export interface ScreenProbe {
  /** `AXIsProcessTrusted` for the host app; `null` when it could not be asked. */
  accessibility: boolean | null;
  /** `CGPreflightScreenCaptureAccess`; `null` when it could not be asked. */
  screenRecording: boolean | null;
  frontmost: ScreenApp | null;
  /** Owner of the topmost on-screen window under the probed / clicked point. */
  ownerAtPoint?: ScreenApp | null;
  /** Primary display in points, and its pixels per point. */
  screen: { width: number; height: number; scale: number };
  done: boolean;
  /** On-screen app windows, front to back, when the probe asked for them. */
  windows?: ScreenWindow[];
  /** A window's text, read through Accessibility (`windowText`). */
  text?: string;
  textTruncated?: boolean;
  /** How `type` delivered the text: `keys`, `paste` or `keys+paste`. */
  via?: string;
  /** A window's controls (`elements`), in walk order. */
  elements?: ScreenElement[];
  elementsTruncated?: boolean;
  /** Elements the walk looked at (`elements`). */
  scanned?: number;
  /** The AX title of the window the walk (`elements`) used. */
  windowTitle?: string;
  /** That window's frame (`elements`), stored so a press finds the same one of same-titled windows. */
  windowFrame?: ScreenFrame;
  /** `press`: what it did, `press` or `set-value`. */
  did?: string;
  /** `press`: the frontmost app right after acting, to show focus stayed put. */
  frontmostAfter?: ScreenApp | null;
  /** `press` refused as `element-changed`: what is at the path now. */
  element?: { role: string; name: string };
  /** `press` refused as `press-unsupported`: the actions the element does answer. */
  actions?: string[];
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

/** A `{x, y, width, height}` of finite numbers, or `null`. */
export function parseFrame(raw: unknown): ScreenFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nums = [o.x, o.y, o.width, o.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { x: o.x as number, y: o.y as number, width: o.width as number, height: o.height as number };
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
    throw new Error("osascript reported no primary display");
  }
  return {
    accessibility: typeof obj.accessibility === "boolean" ? obj.accessibility : null,
    screenRecording:
      typeof obj.screenRecording === "boolean" ? obj.screenRecording : null,
    frontmost: parseApp(obj.frontmost),
    ...("ownerAtPoint" in obj ? { ownerAtPoint: parseApp(obj.ownerAtPoint) } : {}),
    screen: { width, height, scale: scale > 0 ? scale : 1 },
    done: obj.done === true,
    ...(Array.isArray(obj.windows) ? { windows: obj.windows.flatMap(parseWindow) } : {}),
    ...(typeof obj.text === "string" ? { text: obj.text } : {}),
    ...(typeof obj.textTruncated === "boolean" ? { textTruncated: obj.textTruncated } : {}),
    ...(typeof obj.via === "string" ? { via: obj.via } : {}),
    ...(Array.isArray(obj.elements) ? { elements: obj.elements.flatMap(parseElement) } : {}),
    ...(typeof obj.elementsTruncated === "boolean" ? { elementsTruncated: obj.elementsTruncated } : {}),
    ...(typeof obj.scanned === "number" ? { scanned: obj.scanned } : {}),
    ...(typeof obj.windowTitle === "string" ? { windowTitle: obj.windowTitle } : {}),
    ...(parseFrame(obj.windowFrame) ? { windowFrame: parseFrame(obj.windowFrame)! } : {}),
    ...(typeof obj.did === "string" ? { did: obj.did } : {}),
    ...("frontmostAfter" in obj ? { frontmostAfter: parseApp(obj.frontmostAfter) } : {}),
    ...(obj.element && typeof obj.element === "object"
      ? {
          element: {
            role: String((obj.element as Record<string, unknown>).role ?? ""),
            name: String((obj.element as Record<string, unknown>).name ?? ""),
          },
        }
      : {}),
    ...(Array.isArray(obj.actions)
      ? { actions: obj.actions.filter((a): a is string => typeof a === "string") }
      : {}),
    ...(typeof obj.error === "string" ? { error: obj.error } : {}),
  };
}

/** One window entry; a malformed one is dropped, not guessed. */
export function parseWindow(raw: unknown): ScreenWindow[] {
  if (!raw || typeof raw !== "object") return [];
  const w = raw as Record<string, unknown>;
  const nums = [w.id, w.pid, w.x, w.y, w.width, w.height].map(Number);
  if (!nums.every(Number.isFinite) || !(nums[4]! > 0) || !(nums[5]! > 0)) return [];
  const [id, pid, x, y, width, height] = nums as [number, number, number, number, number, number];
  return [
    {
      id,
      pid,
      app: typeof w.app === "string" ? w.app : null,
      bundleId: typeof w.bundleId === "string" ? w.bundleId : null,
      title: typeof w.title === "string" ? w.title : "",
      x,
      y,
      width,
      height,
    },
  ];
}

function parseApp(raw: unknown): ScreenApp | null {
  if (!raw || typeof raw !== "object") return null;
  const app = raw as Record<string, unknown>;
  return {
    name: typeof app.name === "string" ? app.name : null,
    bundleId: typeof app.bundleId === "string" ? app.bundleId : null,
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
    `macOS has not given ${host} Screen Recording permission (or the capture came back empty), so the screenshot would show no windows. ` +
    `Ask the user to open System Settings → Privacy & Security → Screen & System Audio Recording ` +
    `(Screen Recording on older macOS), turn on ${host}, and restart it. ` +
    "Do not retry until the user says it is done."
  );
}

/**
 * Hosts where `os.screen.capture` works (ATO-527 first slice: Windows
 * and Linux take whole-screen pictures). Everything else in `os.screen.*`
 * needs `screenControlSupported`.
 */
export function screenCaptureSupported(os: NodeJS.Platform): boolean {
  return os === "darwin" || os === "win32" || os === "linux";
}

/** Hosts where clicking, typing, keys, window snapshots and pointing work: macOS only for now. */
export function screenControlSupported(os: NodeJS.Platform): boolean {
  return os === "darwin";
}

export function macOnlyMessage(tool: string, os: NodeJS.Platform): string {
  if (screenCaptureSupported(os) && os !== "darwin") {
    return (
      `${tool} works on macOS only for now (this is ${os}). os.screen.capture works here and takes a picture of the whole screen, ` +
      "but clicking, typing, keys and pointing are macOS-only until the next part of ATO-527. Tell the user what to click or type instead."
    );
  }
  return `${tool} works on macOS only (this is ${os}); Windows and Linux support is tracked in ATO-527.`;
}
