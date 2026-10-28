import { execFileSync } from "node:child_process";

/** The UTF-8 console code page on Windows. */
export const UTF8_CODE_PAGE = "65001";

/** What switching the console code page needs from the host, injectable for tests. */
export interface ConsoleCodePageHost {
  platform: NodeJS.Platform;
  /** True when stdout is an interactive console. A pipe (the desktop app, a script) has no console code page to fix. */
  stdoutIsTTY: boolean;
  /** Runs `chcp.com` with `args` and returns its stdout. Throws when the call fails. */
  runChcp: (args: readonly string[]) => string;
  /** Registers a synchronous handler for process exit. */
  onExit: (handler: () => void) => void;
}

function defaultHost(): ConsoleCodePageHost {
  return {
    platform: process.platform,
    stdoutIsTTY: process.stdout.isTTY === true,
    // No `windowsHide`: with no inherited stdio it starts chcp without a
    // console, and chcp then changes nothing. The child shares our console
    // and only works when we have one, which the TTY gate already ensures.
    runChcp: (args) =>
      execFileSync("chcp.com", [...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }),
    onExit: (handler) => {
      process.on("exit", handler);
    },
  };
}

/** The code page number from chcp's output. The wording is localized; the number is the only stable part. */
export function parseCodePage(output: string): string | undefined {
  const numbers = output.match(/\d+/g);
  return numbers ? numbers[numbers.length - 1] : undefined;
}

/**
 * On a Windows console, switch the code page to UTF-8 for the life of the
 * process and put the original back on exit. Consoles default to an OEM
 * page (CP866 on Russian Windows, CP437 or CP850 elsewhere), so non-ASCII
 * text read from or written through the console, and the output of console
 * programs the agent runs, turns into mojibake against Node's UTF-8.
 *
 * chcp changes the whole console session, not just this process, hence the
 * restore. The stdout and stderr streams are not touched, so ink and
 * readline rendering stay as they are. Every failure is ignored: some hosts
 * refuse to read or change the code page, and the agent must still start.
 * A no-op on macOS and Linux, on a non-TTY stdout, and when the console is
 * already UTF-8. Returns true when the code page was switched.
 */
export function ensureUtf8Console(host: ConsoleCodePageHost = defaultHost()): boolean {
  if (host.platform !== "win32" || !host.stdoutIsTTY) return false;
  let previous: string | undefined;
  try {
    previous = parseCodePage(host.runChcp([]));
    if (!previous || previous === UTF8_CODE_PAGE) return false;
    host.runChcp([UTF8_CODE_PAGE]);
  } catch {
    return false;
  }
  const original = previous;
  host.onExit(() => {
    try {
      host.runChcp([original]);
    } catch {
      // Best effort: the console may already be closing.
    }
  });
  return true;
}
