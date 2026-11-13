import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { TerminalLaunch } from "./build-terminal-launch.js";
import {
  openTerminalWindow,
  type OpenTerminalWindowResult,
  type TerminalSpawn,
} from "./open-terminal-window.js";

/**
 * Opens a URL in the operator's default browser — the `[open …]` chips
 * under chat messages. The in-text OSC 8 links depend on the terminal
 * honouring an escape sequence many terminals ignore; this path must
 * not, so it goes through the one opener every platform ships: the OS
 * URL handler.
 */

export type OpenUrlResult = OpenTerminalWindowResult;

/**
 * Resolves "open this URL in the default browser" into a `{cmd, args}`
 * launch for `platform`. Returns `null` for anything that is not plain
 * http(s) — `file:`, `javascript:` and friends reach OS handlers that
 * do far more than browse, and a chat chip must never become a general
 * command runner. Pure so every branch is testable without spawning.
 */
export function buildOpenUrlCommand(
  url: string,
  platform: NodeJS.Platform,
): TerminalLaunch | null {
  const href = canonicalHttpUrl(url);
  if (href === null) return null;
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [href], label: "default browser" };
    case "win32":
      // `start` is a cmd.exe builtin, so it needs the cmd shell — and
      // cmd parses `&`, `^` and `|` in unquoted text as operators, so a
      // query string handed over as a bare argv entry is a truncated
      // URL plus an executed command. The whole `start` line therefore
      // travels as ONE pre-quoted verbatim argument with the URL inside
      // double quotes, where cmd interprets nothing but `%`
      // (`canonicalHttpUrl` guarantees no `"` and no whitespace survive
      // in `href`, so the quoting cannot be broken out of). The leading
      // `""` fills `start`'s window-title slot — without it the quoted
      // URL itself would be read as the title and nothing would open.
      return {
        cmd: "cmd.exe",
        args: ["/c", `start "" "${href}"`],
        label: "default browser",
        windowsVerbatimArguments: true,
      };
    default:
      // linux and the BSDs: xdg-open is the freedesktop opener and
      // resolves the default browser however the desktop defines it.
      return { cmd: "xdg-open", args: [href], label: "default browser" };
  }
}

/**
 * Parses and re-serialises through WHATWG `URL`, refusing every scheme
 * but http(s). The round-trip also percent-encodes `"` and whitespace,
 * which is what lets the win32 branch above interpolate the result into
 * a double-quoted cmd.exe string.
 */
export function canonicalHttpUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

export interface OpenUrlOptions {
  /** Defaults to `process.platform`; injectable for the unit tests. */
  readonly platform?: NodeJS.Platform;
  readonly spawn?: TerminalSpawn;
  readonly settleMs?: number;
}

/**
 * Build + spawn in one call. The detached spawn and the "exit 0 /
 * non-zero with stderr / still running" settle protocol are delegated
 * to `openTerminalWindow` — `open`, `xdg-open` and `cmd /c start` are
 * short-lived launchers with exactly the lifecycle that helper decodes,
 * and it already guarantees the two things this caller needs: the child
 * is unref'd so it outlives the agent, and every failure comes back as
 * a value instead of a throw.
 */
export async function openUrlInBrowser(
  url: string,
  options: OpenUrlOptions = {},
): Promise<OpenUrlResult> {
  const launch = buildOpenUrlCommand(url, options.platform ?? process.platform);
  if (launch === null) {
    return { ok: false, reason: `not an http(s) URL: ${url}` };
  }
  return await openTerminalWindow(launch, {
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
  });
}

/** The only local files the `[open in browser]` chip opens. */
const LOCAL_HTML = /\.html?$/i;

/**
 * Resolves "open this local page in the default browser" (ATO-1139)
 * into a launch, the local-file twin of {@link buildOpenUrlCommand}.
 * Kept apart from it on purpose: that one refuses `file:` so a web chip
 * can never reach the OS file handlers, and this one opens exactly one
 * kind of file — an absolute `.html` / `.htm` path — and nothing else.
 *
 * On win32 the path travels inside the same verbatim `start "" "…"`
 * line as a URL does; a path holding `"` or `%` (cmd would read the
 * latter as a variable) is refused rather than quoted around.
 */
export function buildOpenLocalHtmlCommand(
  filePath: string,
  platform: NodeJS.Platform,
): TerminalLaunch | null {
  if (!LOCAL_HTML.test(filePath)) return null;
  const absolute =
    platform === "win32" ? win32.isAbsolute(filePath) : posix.isAbsolute(filePath);
  if (!absolute) return null;
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [filePath], label: "default browser" };
    case "win32":
      if (/["%\r\n]/.test(filePath)) return null;
      return {
        cmd: "cmd.exe",
        args: ["/c", `start "" "${filePath}"`],
        label: "default browser",
        windowsVerbatimArguments: true,
      };
    default:
      return { cmd: "xdg-open", args: [filePath], label: "default browser" };
  }
}

export interface OpenLocalHtmlOptions extends OpenUrlOptions {
  /** Defaults to a `stat` of the real disk; injectable for the tests. */
  readonly isFile?: (path: string) => boolean;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Opens a local `.html` page the agent wrote in the default browser.
 * The file is checked again at click time: the chip was drawn when the
 * message rendered, and the page may have been moved since.
 */
export async function openLocalHtmlInBrowser(
  filePath: string,
  options: OpenLocalHtmlOptions = {},
): Promise<OpenUrlResult> {
  const launch = buildOpenLocalHtmlCommand(
    filePath,
    options.platform ?? process.platform,
  );
  if (launch === null) {
    return { ok: false, reason: `not a local .html page: ${filePath}` };
  }
  if (!(options.isFile ?? isRegularFile)(filePath)) {
    return { ok: false, reason: `file not found: ${filePath}` };
  }
  return await openTerminalWindow(launch, {
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.settleMs !== undefined ? { settleMs: options.settleMs } : {}),
  });
}
