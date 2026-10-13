import { exit } from "node:process";

/** How long a flush may take before the process exits anyway (a reader that never drains the pipe). */
const FLUSH_GRACE_MS = 5_000;

/** The one call this needs from a stream: an empty write whose callback runs once earlier writes are flushed. */
export interface Flushable {
  write(chunk: string, cb: () => void): boolean;
}

/**
 * Exit with `code` once stdout and stderr have handed everything written so
 * far to the OS. `process.exit` right after a large write drops the rest:
 * a pipe on macOS is written asynchronously, so `models search --json`
 * through a pipe (the desktop app reads every command that way) stopped
 * at 64 KB and the live OpenRouter list never parsed (ATO-355). An empty
 * write's callback runs after the writes queued before it.
 */
export function exitAfterFlush(
  code: number,
  streams: readonly Flushable[] = [process.stdout, process.stderr],
  exitFn: (code: number) => void = exit,
  graceMs = FLUSH_GRACE_MS,
): void {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    exitFn(code);
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
