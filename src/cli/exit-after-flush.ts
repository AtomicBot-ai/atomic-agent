import { exit } from "node:process";

/** How long a flush may take before the process exits anyway (a reader that never drains the pipe). */
const FLUSH_GRACE_MS = 5_000;

/**
 * On Windows, how long the process may take to end on its own once the
 * output is flushed, before it is made to exit (ATO-1198).
 */
const WINDOWS_SETTLE_MS = 300;

/** The one call this needs from a stream: an empty write whose callback runs once earlier writes are flushed. */
export interface Flushable {
  write(chunk: string, cb: () => void): boolean;
}

/** Test seams; production uses the defaults. */
export interface ExitAfterFlushOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to setting `process.exitCode`. */
  readonly setExitCode?: (code: number) => void;
  /** Defaults to `WINDOWS_SETTLE_MS`. */
  readonly settleMs?: number;
}

/**
 * Exit with `code` once stdout and stderr have handed everything written so
 * far to the OS. `process.exit` right after a large write drops the rest:
 * a pipe on macOS is written asynchronously, so `models search --json`
 * through a pipe (the desktop app reads every command that way) stopped
 * at 64 KB and the live OpenRouter list never parsed (ATO-355). An empty
 * write's callback runs after the writes queued before it.
 *
 * On Windows `process.exit` itself can crash the process: Node tears its
 * platform down while a V8 background task still posts to an async handle
 * that is already closing, and libuv aborts with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in
 * `src\win\async.c` (nodejs/node#56645). It is most likely right after a
 * `fetch` (a model list, a provider call), and the exit code is lost
 * (ATO-1198). So on Windows the code goes to `process.exitCode` and the
 * process ends on its own when nothing is left to run; only when
 * something still holds the event loop after `settleMs` does it exit
 * the hard way, by then with the background work done. The settle timer
 * is unref'd, so it never keeps the process alive by itself. macOS and
 * Linux exit as before.
 */
export function exitAfterFlush(
  code: number,
  streams: readonly Flushable[] = [process.stdout, process.stderr],
  exitFn: (code: number) => void = exit,
  graceMs = FLUSH_GRACE_MS,
  options: ExitAfterFlushOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const setExitCode = options.setExitCode ?? ((value: number) => { process.exitCode = value; });
  const settleMs = options.settleMs ?? WINDOWS_SETTLE_MS;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (platform !== "win32") {
      exitFn(code);
      return;
    }
    setExitCode(code);
    setTimeout(() => exitFn(code), settleMs).unref();
  };
  setTimeout(finish, graceMs).unref();
  let pending = streams.length;
  if (pending === 0) return finish();
  for (const stream of streams) {
    try {
      // An EPIPE (the reader went away) still calls back; nothing is left to wait for.
      stream.write("", () => {
        if (--pending === 0) finish();
      });
    } catch {
      if (--pending === 0) finish();
    }
  }
}
